const SOFTWARE_RENDERER_PATTERN =
  /swiftshader|llvmpipe|lavapipe|softpipe|swrast|software raster|software renderer|basic render driver/i;
const HARDWARE_RENDERER_PATTERN =
  /nvidia|geforce|quadro|radeon|\bamd\b|\bintel\b|apple\s+(?:m\d|gpu)|adreno|mali|powervr|qualcomm/i;

export function classifyWebGlRenderer(vendor, renderer) {
  const description = `${vendor ?? ""} ${renderer ?? ""}`.trim();
  const softwareRenderer = SOFTWARE_RENDERER_PATTERN.test(description);
  return {
    softwareRenderer,
    hardwareRendererVerified:
      !softwareRenderer && HARDWARE_RENDERER_PATTERN.test(description),
  };
}
