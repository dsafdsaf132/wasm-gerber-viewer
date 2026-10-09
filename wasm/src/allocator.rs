//! Geometric WASM heap growth; allocation ownership stays in dlmalloc.

const PAGE_BYTES: usize = 64 * 1024;
const MAX_GROWTH_BYTES: usize = 512 * 1024 * 1024;
const INITIAL_GROWTH_FLOOR_BYTES: usize = 16 * 1024 * 1024;
const INITIAL_GROWTH_PHASE_BYTES: usize = 64 * 1024 * 1024;
// Keep wasm32 speculative growth within the viewer's picking-reserve cutoff.
const WASM32_SPECULATIVE_GROWTH_CUTOFF_BYTES: usize = 2 * 1024 * 1024 * 1024;

const DEFAULT_SPECULATIVE_GROWTH_LIMIT_BYTES: usize = if usize::BITS == 32 {
    WASM32_SPECULATIVE_GROWTH_CUTOFF_BYTES
} else {
    usize::MAX
};
static SPECULATIVE_GROWTH_LIMIT_BYTES: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(DEFAULT_SPECULATIVE_GROWTH_LIMIT_BYTES);

fn speculative_growth_limit() -> usize {
    SPECULATIVE_GROWTH_LIMIT_BYTES.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
pub(crate) fn set_speculative_growth_limit_pages(pages: u32) {
    let bytes = (pages as usize).saturating_mul(PAGE_BYTES);
    SPECULATIVE_GROWTH_LIMIT_BYTES.store(
        bytes.min(DEFAULT_SPECULATIVE_GROWTH_LIMIT_BYTES),
        std::sync::atomic::Ordering::Relaxed,
    );
}

fn growth_pages(
    current_bytes: usize,
    required_bytes: usize,
    speculative_limit_bytes: usize,
) -> Option<(usize, usize)> {
    // Ceil(current * 0.30) without floating point or overflowing multiplication.
    let proportional = current_bytes / 10 * 3 + (current_bytes % 10 * 3).div_ceil(10);
    let initial_floor = if current_bytes > 0 && current_bytes < INITIAL_GROWTH_PHASE_BYTES {
        INITIAL_GROWTH_FLOOR_BYTES
    } else {
        0
    };
    let preferred = required_bytes.max(proportional.max(initial_floor).min(MAX_GROWTH_BYTES));
    let required_pages = required_bytes.max(1).checked_add(PAGE_BYTES - 1)? / PAGE_BYTES;
    let mut preferred_pages = preferred.max(1).checked_add(PAGE_BYTES - 1)? / PAGE_BYTES;
    // Bound spare capacity, but never truncate the allocation requirement.
    if speculative_limit_bytes != usize::MAX {
        let remaining_pages = speculative_limit_bytes.saturating_sub(current_bytes) / PAGE_BYTES;
        preferred_pages = preferred_pages.min(remaining_pages).max(required_pages);
    }
    Some((preferred_pages, required_pages))
}

#[inline]
fn grow_with_fallback(
    current_bytes: usize,
    required_bytes: usize,
    mut grow: impl FnMut(usize) -> usize,
) -> Option<(usize, usize)> {
    let (preferred, required) =
        growth_pages(current_bytes, required_bytes, speculative_growth_limit())?;
    let mut pages = preferred;
    let mut previous = grow(pages);
    if previous == usize::MAX && preferred != required {
        // One retry with required capacity; never repeatedly grow on failure.
        pages = required;
        previous = grow(pages);
    }
    if previous == usize::MAX {
        return None;
    }
    Some((
        previous.checked_mul(PAGE_BYTES)?,
        pages.checked_mul(PAGE_BYTES)?,
    ))
}

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
mod global {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use core::arch::wasm32 as wasm;
    #[cfg(target_arch = "wasm64")]
    use core::arch::wasm64 as wasm;
    use dlmalloc::{Allocator, Dlmalloc};
    use std::alloc::{GlobalAlloc, Layout};
    use std::cell::{Cell, UnsafeCell};
    use std::ptr;

    #[cfg(target_feature = "atomics")]
    compile_error!("The growth allocator requires a non-threaded WASM build");

    extern "C" {
        static __heap_base: u8;
        static __heap_end: u8;
    }

    struct MemorySystem {
        initial_heap_used: Cell<bool>,
    }

    // SAFETY: Donate unused linker heap once or return fresh zeroed WASM pages.
    // Blocks are aligned, disjoint and cover the request. Linear memory cannot
    // be released. This matches the default WASM backend's ownership contract.
    unsafe impl Allocator for MemorySystem {
        fn alloc(&self, size: usize) -> (*mut u8, usize, u32) {
            if !self.initial_heap_used.replace(true) {
                let base = ptr::addr_of!(__heap_base) as usize;
                let end = ptr::addr_of!(__heap_end) as usize;
                if base != 0 && end > base && end - base >= size {
                    return (base as *mut u8, end - base, 0);
                }
            }
            let Some(current_bytes) = wasm::memory_size(0).checked_mul(PAGE_BYTES) else {
                return (ptr::null_mut(), 0, 0);
            };
            let Some((base, mut bytes)) =
                grow_with_fallback(current_bytes, size, wasm::memory_grow::<0>)
            else {
                return (ptr::null_mut(), 0, 0);
            };
            // Match the default backend's pointer-wrap handling.
            if base.wrapping_add(bytes) == 0 {
                bytes -= 16;
            }
            (base as *mut u8, bytes, 0)
        }
        fn remap(&self, _: *mut u8, _: usize, _: usize, _: bool) -> *mut u8 {
            ptr::null_mut()
        }
        fn free_part(&self, _: *mut u8, _: usize, _: usize) -> bool {
            false
        }
        fn free(&self, _: *mut u8, _: usize) -> bool {
            false
        }
        fn can_release_part(&self, _: u32) -> bool {
            false
        }
        fn allocates_zeros(&self) -> bool {
            true
        }
        fn page_size(&self) -> usize {
            PAGE_BYTES
        }
    }

    struct GrowthAllocator(UnsafeCell<Dlmalloc<MemorySystem>>);

    // SAFETY: Restricted to non-threaded WASM. Workers have separate heaps;
    // the backend never calls JS or reenters the allocator.
    unsafe impl Sync for GrowthAllocator {}

    #[global_allocator]
    static ALLOCATOR: GrowthAllocator = GrowthAllocator(UnsafeCell::new(
        Dlmalloc::new_with_allocator(MemorySystem {
            initial_heap_used: Cell::new(false),
        }),
    ));

    // SAFETY: Exclusive access to one allocator with caller-provided layouts.
    // Failed realloc leaves the original block valid.
    unsafe impl GlobalAlloc for GrowthAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            unsafe { (&mut *self.0.get()).malloc(layout.size(), layout.align()) }
        }
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            unsafe { (&mut *self.0.get()).calloc(layout.size(), layout.align()) }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { (&mut *self.0.get()).free(ptr, layout.size(), layout.align()) };
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            unsafe { (&mut *self.0.get()).realloc(ptr, layout.size(), layout.align(), new_size) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proportional_growth_is_page_aligned_and_capped() {
        assert_eq!(
            growth_pages(INITIAL_GROWTH_PHASE_BYTES * 4, PAGE_BYTES, usize::MAX),
            Some((1229, 1))
        );
        assert_eq!(
            growth_pages(4 * MAX_GROWTH_BYTES, PAGE_BYTES, usize::MAX),
            Some((MAX_GROWTH_BYTES / PAGE_BYTES, 1))
        );
        assert_eq!(
            growth_pages(usize::MAX, PAGE_BYTES, usize::MAX),
            Some((MAX_GROWTH_BYTES / PAGE_BYTES, 1))
        );
        assert_eq!(growth_pages(0, 0, usize::MAX), Some((1, 1)));
        assert_eq!(growth_pages(0, PAGE_BYTES + 1, usize::MAX), Some((2, 2)));
    }

    #[test]
    fn large_allocations_are_not_limited_by_spare_capacity_cap() {
        let pages = MAX_GROWTH_BYTES / PAGE_BYTES + 1;
        assert_eq!(
            growth_pages(MAX_GROWTH_BYTES, MAX_GROWTH_BYTES + 1, usize::MAX),
            Some((pages, pages))
        );
        assert_eq!(growth_pages(0, usize::MAX, usize::MAX), None);
    }

    #[test]
    fn small_initial_heap_growth_uses_a_16_mib_floor() {
        assert_eq!(
            growth_pages(24 * PAGE_BYTES, PAGE_BYTES, usize::MAX),
            Some((INITIAL_GROWTH_FLOOR_BYTES / PAGE_BYTES, 1))
        );
        assert_eq!(
            growth_pages(INITIAL_GROWTH_PHASE_BYTES, PAGE_BYTES, usize::MAX),
            Some((308, 1))
        );
    }

    #[test]
    fn wasm32_speculative_growth_stays_within_the_cutoff() {
        let current = 25_206 * PAGE_BYTES;
        // A speculative increase ending exactly at the cutoff is allowed.
        assert_eq!(
            growth_pages(current, PAGE_BYTES, WASM32_SPECULATIVE_GROWTH_CUTOFF_BYTES),
            Some((7_562, 1))
        );
        assert_eq!(
            growth_pages(
                current + PAGE_BYTES,
                PAGE_BYTES,
                WASM32_SPECULATIVE_GROWTH_CUTOFF_BYTES
            ),
            Some((7_561, 1))
        );
        for bytes in [
            WASM32_SPECULATIVE_GROWTH_CUTOFF_BYTES - PAGE_BYTES,
            WASM32_SPECULATIVE_GROWTH_CUTOFF_BYTES,
            WASM32_SPECULATIVE_GROWTH_CUTOFF_BYTES + PAGE_BYTES,
            usize::MAX,
        ] {
            assert_eq!(
                growth_pages(bytes, PAGE_BYTES, WASM32_SPECULATIVE_GROWTH_CUTOFF_BYTES),
                Some((1, 1))
            );
        }
        assert_eq!(
            growth_pages(
                24 * PAGE_BYTES,
                PAGE_BYTES,
                WASM32_SPECULATIVE_GROWTH_CUTOFF_BYTES
            ),
            Some((INITIAL_GROWTH_FLOOR_BYTES / PAGE_BYTES, 1))
        );
    }

    #[test]
    fn cutoff_preserves_required_growth_and_wasm64_speculation() {
        let current = WASM32_SPECULATIVE_GROWTH_CUTOFF_BYTES;
        let required = MAX_GROWTH_BYTES + 1;
        let pages = MAX_GROWTH_BYTES / PAGE_BYTES + 1;
        assert_eq!(
            growth_pages(current, required, WASM32_SPECULATIVE_GROWTH_CUTOFF_BYTES),
            Some((pages, pages))
        );
        assert_eq!(
            growth_pages(
                current,
                PAGE_BYTES + 1,
                WASM32_SPECULATIVE_GROWTH_CUTOFF_BYTES
            ),
            Some((2, 2))
        );
        assert_eq!(
            growth_pages(current, PAGE_BYTES, usize::MAX),
            Some((MAX_GROWTH_BYTES / PAGE_BYTES, 1))
        );
    }

    #[test]
    fn device_ceiling_caps_spare_capacity_without_truncating_requests() {
        let mib = 1024 * 1024;
        let limit = 3584 * mib;
        let current = 3481 * mib;
        assert_eq!(
            growth_pages(current, PAGE_BYTES, limit),
            Some(((limit - current) / PAGE_BYTES, 1))
        );
        // A partial page of remaining headroom cannot hold spare capacity.
        assert_eq!(growth_pages(limit - 1, PAGE_BYTES, limit), Some((1, 1)));
        assert_eq!(growth_pages(limit, PAGE_BYTES, limit), Some((1, 1)));
        assert_eq!(
            growth_pages(limit + PAGE_BYTES, PAGE_BYTES, limit),
            Some((1, 1))
        );
        let required = 200 * mib;
        assert_eq!(
            growth_pages(current, required, limit),
            Some((required / PAGE_BYTES, required / PAGE_BYTES))
        );
    }

    #[test]
    fn failed_spare_growth_retries_only_required_size() {
        let current_bytes = INITIAL_GROWTH_PHASE_BYTES * 4;
        let preferred_pages = growth_pages(current_bytes, PAGE_BYTES, speculative_growth_limit())
            .unwrap()
            .0;
        let mut calls = 0;
        let result = grow_with_fallback(current_bytes, PAGE_BYTES, |pages| {
            calls += 1;
            assert_eq!(pages, if calls == 1 { preferred_pages } else { 1 });
            if calls == 1 {
                usize::MAX
            } else {
                10
            }
        });
        assert_eq!(result, Some((10 * PAGE_BYTES, PAGE_BYTES)));
        assert_eq!(calls, 2);
    }

    #[test]
    fn successful_growth_has_no_retry() {
        let current_bytes = INITIAL_GROWTH_PHASE_BYTES * 4;
        let preferred_pages = growth_pages(current_bytes, PAGE_BYTES, speculative_growth_limit())
            .unwrap()
            .0;
        let mut calls = 0;
        assert_eq!(
            grow_with_fallback(current_bytes, PAGE_BYTES, |pages| {
                calls += 1;
                assert_eq!(pages, preferred_pages);
                current_bytes / PAGE_BYTES
            }),
            Some((current_bytes, preferred_pages * PAGE_BYTES))
        );
        assert_eq!(calls, 1);
    }

    #[test]
    fn exhaustion_and_overflow_fail_without_looping() {
        let mut calls = 0;
        assert_eq!(
            grow_with_fallback(INITIAL_GROWTH_PHASE_BYTES * 4, PAGE_BYTES, |_| {
                calls += 1;
                usize::MAX
            }),
            None
        );
        assert_eq!(calls, 2);
        calls = 0;
        assert_eq!(
            grow_with_fallback(0, PAGE_BYTES, |_| {
                calls += 1;
                usize::MAX
            }),
            None
        );
        assert_eq!(calls, 1);
        assert_eq!(
            grow_with_fallback(0, usize::MAX, |_| panic!("must not grow")),
            None
        );
    }
}
