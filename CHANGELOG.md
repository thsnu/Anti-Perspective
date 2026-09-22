# Changelog

## v1.2 — 2026-09-22

### Added
- **Colour profiles are preserved on export.** If the source image carries an embedded RGB ICC
  profile (Display P3 from iPhone or Mac, Adobe RGB, ProPhoto, …), the exported PNG contains the
  original, unconverted pixel values together with that very profile. Colours outside sRGB are no
  longer clipped.
  - Supported containers: JPEG (APP2 `ICC_PROFILE`, including profiles split across several
    segments), PNG (`iCCP`), WebP (`ICCP`).
  - The profile is embedded byte-identically as an `iCCP` chunk. Any colour description the
    browser wrote (`sRGB`, `gAMA`, `cHRM`, `cICP`) is removed.
- The status bar shows the name of the embedded profile and whether it is kept; a tooltip explains
  why it is not.

### Changed
- The source pane and the result pane still show the colour-managed image. Only the export
  works on the unconverted values, so it now decodes the source file once more and takes a
  moment longer. The export button reads "Exporting…" meanwhile.
- If the profile cannot be preserved during export, the app asks whether to export as sRGB
  instead. It never saves unconverted values without their profile.
- Internal: `rectify()` takes the source pixels as a parameter and returns the canvas;
  `drawWarped()` accepts an optional texture.

### Unchanged / limitations
- Images without a profile, grey or CMYK profiles, and formats other than JPEG, PNG and WebP
  (HEIC, AVIF, TIFF) are exported as sRGB, as before.
- Output stays 8 bit per channel; 16-bit sources lose depth.
- Preserving the profile needs `CompressionStream` / `DecompressionStream`
  (Chrome 80+, Safari 16.4+, Firefox 113+). Older browsers fall back to sRGB.

## v1.1

Previous release. Its feature set is described in the README.
