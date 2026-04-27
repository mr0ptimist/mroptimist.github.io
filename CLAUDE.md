# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hugo static blog (https://mr0ptimist.github.io/) using the PaperMod theme as a git submodule. Content is in Chinese, focused on graphics rendering, GPU optimization, and game engine internals. Deployed to GitHub Pages via GitHub Actions on push to `main`.

## Development Commands

```bash
hugo server -D                  # Local preview (includes drafts)
hugo                            # Build to public/
python scripts/new-post.py              # Interactive post creation with tag/category suggestions
python scripts/organize_post_images.py  # Organize post images into Page Bundles with compression
python scripts/organize_post_images.py --dry-run  # Preview plan without executing
python scripts/organize_post_images.py --post "文章名"  # Only process a specific post
```

Equivalent `.bat` files in `bat/`: `serve_启动预览.bat`, `build_构建发布.bat`, `new-post_新建文章.bat`, `clean_清除输出.bat`, `organize_images_整理贴图.bat`.

Hugo version: 0.160.1 extended.

## Architecture

- **Theme**: PaperMod imported as git submodule at `themes/PaperMod` — never modify theme files directly
- **Customization**: All overrides go in `layouts/` (partials), `assets/css/extended/`, and `archetypes/`
- **Client-side features** in `layouts/partials/extend_footer.html`:
  - Auto-collapsible `##` headings (details/summary) — don't add manual `<details>` tags around `##`
  - Password-protected posts (`hidden: true` front matter, unlocked via nav bar)
  - Responsive width slider + TOC width slider (persisted in sessionStorage)
  - TOC auto-filtering (hides deeply nested headings, highlights active section)
- **DDS/EXR Direct Viewer**: header parsing + pixel decode + WebGL canvas display. No preview PNGs needed — reference DDS/EXR files directly in markdown.
  - **DDS parser**: DX10 + legacy headers, formats: RGBA8, R10G10B10A2, R8G8, R8, R16G16, R16/R16F, D32S8 (8 bytes/px, skip stencil padding), BC1/BC4/BC5 (CPU decode), BC7/BC6H (WebGL `EXT_texture_compression_bptc`). DX10 uncompressed formats MUST set `bpp` from `DXGI_BPP` table.
  - **EXR parser**: uncompressed OpenEXR only, float32/half16 channels, Reinhard + gamma 2.2 tone map.
  - **Web Worker**: DDS/EXR pixel decode offloaded to background thread. Transferable ArrayBuffer zero-copy. Inline worker via Blob URL. BC7/BC6H stays on main thread (needs WebGL).
  - **IntersectionObserver**: lazy-load images within 800px of viewport. `ddsCache`/`exrCache` avoid re-decode on channel/mip switch.
  - **Channel viewer**: R/G/B/A/RGB/RGBA buttons on each image. Canvas 2D `drawImage`+`getImageData` for pixel read (faster than WebGL round-trip). Auto-detects single-channel formats (e.g. R32_FLOAT → only "R" button).
  - **JSON sidecar**: each DDS/EXR has a `.json` file with `renderdoc.format`, `renderdoc.mips`, `renderdoc.size`, `ai.pipeline_stage`, `ai.content`. Metadata overlay + format-aware channel auto-detection. MIP slider appears when `mips > 1`.
  - **Format detection**: `detectFmt()` maps FourCC/DXGI to type string. DX10 → `DXGI_MAP`. Legacy → pixel-format masks. `DXGI_BPP` stores bits-per-pixel for uncompressed formats.
- **Auto-restart**: after editing any file in this project, Claude must restart `hugo server` so changes take effect immediately
- **Custom header**: `layouts/partials/header.html` (theme toggle, width controls, secret unlock button)

## Content Rules

Content writing guidelines are in `content/posts/CLAUDE.md`. Key points:

- Front matter uses **TOML** format with `+++` delimiters (not YAML `---`)
- Required fields: `date` (ISO 8601 with timezone), `draft`, `title`, `tags`, `categories`
- `hidden: true` makes a post password-protected
- Reuse existing tags/categories (see `content/posts/CLAUDE.md` for lists)
- Research articles must cite sources with links; verify all URLs are accessible before including them
- Images use Hugo Page Bundles: post images go in `content/posts/{post-name}/` alongside `index.md`, referenced as relative paths
  - **RenderDoc captures**: export resources as DDS/EXR, place in `images/` subdirectory alongside a JSON sidecar per resource. Reference DDS/EXR directly in markdown — browser JS decodes and displays them.
  - **Screenshots / non-renderdoc**: save as WebP/PNG, run `organize_post_images.py` for compression + Page Bundle organization
- **Local-only content**: `content/local/` folder for posts visible only in `hugo server` (development). Production builds (`hugo`) ignore this folder via `config/production/hugo.toml` `ignoreFiles`. Structure follows same Page Bundle convention as `content/posts/`.
- All `##` headings auto-collapse via JS — don't wrap them in additional `<details>` HTML
