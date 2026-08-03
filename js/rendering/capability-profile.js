export const THREADED_CAPABILITY_PROFILES = Object.freeze([]);

export function getCapabilityProfileKey(capabilities = {}) {
  const memoryGiB = Number(capabilities.deviceMemory ?? 0);
  const cores = Number(capabilities.hardwareConcurrency ?? 0);
  return `${capabilities.browser ?? "unknown"}:${cores}:${memoryGiB}`;
}

export function selectThreadedCapabilityProfile(
  capabilities,
  profiles = THREADED_CAPABILITY_PROFILES,
) {
  if (!capabilities?.threadedSupported) return null;
  const key = getCapabilityProfileKey(capabilities);
  return profiles.find((profile) => profile.key === key && profile.enabled) ?? null;
}
