//! Geometric memory64 heap growth; allocation ownership stays in dlmalloc.

const PAGE_BYTES: usize = 64 * 1024;
const MAX_GROWTH_BYTES: usize = 512 * 1024 * 1024;

fn growth_pages(current_bytes: usize, required_bytes: usize) -> Option<(usize, usize)> {
    // Ceil(current * 0.30) without floating point or overflowing multiplication.
    let proportional = current_bytes / 10 * 3 + (current_bytes % 10 * 3).div_ceil(10);
    let preferred = required_bytes.max(proportional.min(MAX_GROWTH_BYTES));
    let required_pages = required_bytes.max(1).checked_add(PAGE_BYTES - 1)? / PAGE_BYTES;
    let preferred_pages = preferred.max(1).checked_add(PAGE_BYTES - 1)? / PAGE_BYTES;
    Some((preferred_pages, required_pages))
}

#[inline]
fn grow_with_fallback(
    current_bytes: usize,
    required_bytes: usize,
    mut grow: impl FnMut(usize) -> usize,
) -> Option<(usize, usize)> {
    let (preferred, required) = growth_pages(current_bytes, required_bytes)?;
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

#[cfg(target_arch = "wasm64")]
mod global {
    use super::*;
    use dlmalloc::{Allocator, Dlmalloc};
    use std::alloc::{GlobalAlloc, Layout};
    use std::cell::{Cell, UnsafeCell};
    use std::ptr;

    #[cfg(target_feature = "atomics")]
    compile_error!("The memory64 growth allocator requires a non-threaded WASM build");

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
            let Some(current_bytes) = core::arch::wasm64::memory_size(0).checked_mul(PAGE_BYTES)
            else {
                return (ptr::null_mut(), 0, 0);
            };
            let Some((base, mut bytes)) = grow_with_fallback(current_bytes, size, |pages| {
                core::arch::wasm64::memory_grow(0, pages)
            }) else {
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

    // SAFETY: Restricted to non-threaded wasm64. Workers have separate heaps;
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
        assert_eq!(growth_pages(10 * PAGE_BYTES, PAGE_BYTES), Some((3, 1)));
        assert_eq!(growth_pages(11 * PAGE_BYTES, PAGE_BYTES), Some((4, 1)));
        assert_eq!(
            growth_pages(4 * MAX_GROWTH_BYTES, PAGE_BYTES),
            Some((MAX_GROWTH_BYTES / PAGE_BYTES, 1))
        );
        assert_eq!(
            growth_pages(usize::MAX, PAGE_BYTES),
            Some((MAX_GROWTH_BYTES / PAGE_BYTES, 1))
        );
        assert_eq!(growth_pages(0, 0), Some((1, 1)));
        assert_eq!(growth_pages(0, PAGE_BYTES + 1), Some((2, 2)));
    }

    #[test]
    fn large_allocations_are_not_limited_by_spare_capacity_cap() {
        let pages = MAX_GROWTH_BYTES / PAGE_BYTES + 1;
        assert_eq!(
            growth_pages(MAX_GROWTH_BYTES, MAX_GROWTH_BYTES + 1),
            Some((pages, pages))
        );
        assert_eq!(growth_pages(0, usize::MAX), None);
    }

    #[test]
    fn failed_spare_growth_retries_only_required_size() {
        let mut calls = 0;
        let result = grow_with_fallback(10 * PAGE_BYTES, PAGE_BYTES, |pages| {
            calls += 1;
            assert_eq!(pages, if calls == 1 { 3 } else { 1 });
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
        let mut calls = 0;
        assert_eq!(
            grow_with_fallback(10 * PAGE_BYTES, PAGE_BYTES, |pages| {
                calls += 1;
                assert_eq!(pages, 3);
                10
            }),
            Some((10 * PAGE_BYTES, 3 * PAGE_BYTES))
        );
        assert_eq!(calls, 1);
    }

    #[test]
    fn exhaustion_and_overflow_fail_without_looping() {
        let mut calls = 0;
        assert_eq!(
            grow_with_fallback(10 * PAGE_BYTES, PAGE_BYTES, |_| {
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
