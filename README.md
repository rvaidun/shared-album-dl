# shared-album-dl

Download everything from an **iCloud Shared Album** in one go, with the uploader's name in every file name, and skip the photos you added yourself.

Your iPhone friends share trip photos in an iCloud Shared Album, but you keep your photos in Google Photos. Without this tool you have to save each photo by hand (or download everything, including photos you already have), then upload them all. `shared-album-dl` downloads only the other people's photos, gives the files clear names, and leaves the photo metadata alone. You can then drag the folder into Google Photos.

```
  Summer Trip  shared by Ann Smithson
  279 items · 245 photos · 34 videos · 445.6 MB  2026-11-17 → 2026-11-25

    Uploader                    Photos   Videos       Size
  ✔ Jane Appleseed                  73       17   171.2 MB
  ✔ Ann Smithson                    54       13   120.5 MB
  ✖ John Appleseed  excluded        62        0    61.2 MB

  Saving to  ./Summer Trip
  Name       {date}_{time}_{uploader}_{name}  →  2026-11-20_10-05-29_Ann-Smithson_IMG_5038.jpg
  Plan       217 to download (384.4 MB) · 62 filtered out

⠹ ████████████░░░░░░░░░░░░░░░░░░  41%  89/217  158.2 MB · 6.1 MB/s · ETA 0:37
```

## Features

- **Skip your own uploads.** Use `-x "Your Name"`, or set it once with an environment variable.
- **Uploader in the file name.** Choose from 6 presets or build your own template, including one sub-folder per person.
- **Metadata left alone.** Photos are saved exactly as Apple serves them, so the EXIF data (GPS location, camera, lens, exposure, capture time) stays intact.
- **Correct dates in Google Photos.** If a photo has no "date taken", the album's capture date is written into it. Videos, which Apple stamps with the upload time, get their real capture time. Each file's modified date is also set to the capture time.
- **Only new items on re-runs.** A small manifest in the output folder remembers what was saved, so you can run the same command again later to pick up new photos.
- **Safe to interrupt.** Ctrl+C stops cleanly, and re-running continues where it stopped.
- **Nice terminal output.** Colors, a live progress bar with speed and ETA, parallel downloads and automatic retries.
- **No dependencies.** It's plain Node.js, so there's nothing to install.

## Install

Requires **Node.js 22.13+**.

```bash
git clone https://github.com/rvaidun/shared-album-dl.git
cd shared-album-dl
npm link          # optional: puts `shared-album-dl` on your PATH
```

Without `npm link`, run `./bin/shared-album-dl.js` instead.

## Usage

The album must have **Public Website** turned on (in Photos: open the shared album → People icon → Public Website). Copy the link it gives you, which looks like `https://www.icloud.com/sharedalbum/#B0aB…`.

> Always put the link in **single quotes**. It contains `#`, which your shell would otherwise treat as the start of a comment.

```bash
# See who uploaded what (downloads nothing)
shared-album-dl info '<link>'

# Preview the file names (dry run)
shared-album-dl '<link>' -x "Your Name" -n

# Download everything except your own uploads
shared-album-dl '<link>' -x "Your Name" -o ~/Downloads/"Summer Trip"

# One folder per uploader, file names in Los Angeles time
shared-album-dl '<link>' -f folders --tz America/Los_Angeles

# Only videos from one person
shared-album-dl '<link>' --only "Jane" --videos
```

### Options

| Option | Description |
|---|---|
| `-x, --exclude <name>` | Skip items by this uploader. Repeatable. |
| `--only <name>` | Only items by this uploader. Repeatable. |
| `-o, --out <dir>` | Output folder (default: `./<album name>`). |
| `-f, --format <fmt>` | Preset name or custom template (default: `default`). |
| `--photos` / `--videos` | Only photos / only videos. |
| `--since <YYYY-MM-DD>` / `--until <YYYY-MM-DD>` | Filter by capture date. |
| `--tz <zone>` | IANA time zone for `{date}`/`{time}`, e.g. `America/Los_Angeles` (default: your computer's). |
| `--no-fix-dates` | Don't write capture dates into files. |
| `-j, --concurrency <n>` | Parallel downloads, 1–32 (default: 6). |
| `-n, --dry-run` | Show the plan without downloading. |
| `--force` | Re-download items that were already saved. |
| `--all` | Ignore `SHARED_ALBUM_DL_EXCLUDE` for this run. |
| `-v, --verbose` | Print each file as it finishes. |

Name matching uses whole words and ignores case and accents: `-x jane` matches "Jane Appleseed", but `-x smith` does **not** match "Ann Smithson". The CLI warns you if a name doesn't match anyone in the album.

### Always exclude yourself

```bash
# ~/.zshrc or ~/.bashrc
export SHARED_ALBUM_DL_EXCLUDE="Your Name"     # comma-separate several names
```

## File name formats

Use `-f <preset>`, or run `shared-album-dl formats` to see every token, rendered from a sample item. Add a link (`shared-album-dl formats '<link>'`) to render them from a real photo in that album instead.

| Preset | Template | Example |
|---|---|---|
| `default` | `{date}_{time}_{uploader}_{name}` | `2026-11-25_11-31-16_Jane-Appleseed_IMG_1234.jpg` |
| `by-uploader` | `{uploader}_{date}_{time}_{name}` | `Jane-Appleseed_2026-11-25_11-31-16_IMG_1234.jpg` |
| `compact` | `{datetime}_{initials}_{name}` | `20261125_113116_JA_IMG_1234.jpg` |
| `original` | `{name}_{uploader}` | `IMG_1234_Jane-Appleseed.jpg` |
| `folders` | `{uploader}/{date}_{time}_{name}` | `Jane-Appleseed/2026-11-25_11-31-16_IMG_1234.jpg` |
| `indexed` | `{index}_{uploader}_{name}` | `0042_Jane-Appleseed_IMG_1234.jpg` |

**Custom templates.** Combine any of these tokens:

`{uploader}` `{uploader_first}` `{uploader_last}` `{initials}` `{name}` `{date}` `{time}` `{datetime}` `{year}` `{month}` `{day}` `{uploaded}` `{type}` `{album}` `{owner}` `{index}` `{guid}` `{caption}`

```bash
shared-album-dl '<link>' -f '{year}/{month}/{date}_{uploader}_{name}'
```

The extension is added for you, and `/` creates sub-folders. If two items would get the same name, the later ones get `_2`, `_3`, and so on. A different file that's already on disk is never overwritten.

## What's kept, and what Apple removes

| | Preserved |
|---|---|
| **Photos with EXIF** | The original bytes, untouched: GPS location, camera and lens, ISO, aperture, shutter speed, and capture time with its time-zone offset. Google Photos reads all of these. |
| **Photos without EXIF** | Images saved from WhatsApp or Messages before being shared often have no metadata at all. `DateTimeOriginal` and its offset are added from the album's capture time, and any other existing tags are kept. There's no location to recover. |
| **Videos** | Apple re-encodes shared-album videos to **720p**, **removes GPS and camera info**, and stamps them with the upload time. The real capture time is written back into the QuickTime headers (`mvhd`/`tkhd`/`mdhd`). Only those date fields change, never the video data or file size. |
| **Album-only info** | Uploader, date added to the album, and caption. These aren't stored inside the files, so they're saved in `.shared-album-dl.json` in the output folder. |

iCloud Shared Albums store reduced-size copies (photos around 4 MP, e.g. 2731×1537, and videos up to 720p), not the full originals. That's an Apple limitation, and no tool can get better quality from a shared album.

## How it works

It uses the same unauthenticated `sharedstreams` API that the iCloud.com shared-album web page uses:

1. `POST /webstream` returns the album name and each item's metadata, including the uploader and the available sizes.
2. `POST /webasseturls` (in batches of 25) returns temporary download URLs.
3. For each item it chooses the largest version (for videos, the video stream rather than the poster image) and downloads it to a `.part` file.
4. It writes the capture date into the file where needed (see above), using built-in JPEG/EXIF and MP4 code with no exiftool required, then renames the file into place.

No Apple ID or login is needed, and nothing is uploaded anywhere.

## Development

```bash
npm test
```

## Credits

The API details come from [ghostops/ICloud-Shared-Album](https://github.com/ghostops/ICloud-Shared-Album).

## License

MIT
