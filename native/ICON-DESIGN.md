# McpGo Icon — Infinity / Play (concept 4)

- Master vector: `McpGoMark.svg`, SVG viewBox 1024×1024, editable cubic Bézier paths.
- Generator: `python3 native/build-icon.py` uses the same cubic control points for vector SVG and the raster app icon exports.
- Generated: `McpGoMark.png`, `AppIcon.iconset/*` (16–1024 px), `AppIcon.icns`.
- Art direction: rounded deep navy square, continuous infinity loop from cyan to violet, play triangle in the right loop. It symbolizes persistent tools/agent orchestration and the ability to start tasks.
- macOS app bundle resources: `McpGo.app/Contents/Resources/{AppIcon.icns,McpGoMark.png,McpGoMark.svg}`. Sidebar uses PNG; Dock and Finder use ICNS.
- Always copy generated assets into app **before** `codesign --force --deep --sign -`; verify `codesign --verify --strict`.
- Previous icon and sidebar source backup: `native/icon-backup-20261107`.
