# Member Photo R2 Setup

The Worker now supports Cloudflare R2 for fast member-photo delivery.

## Required bucket

Create this R2 bucket in the same Cloudflare account used for the Worker:

- Bucket name: `sdlm-member-photos`
- Worker binding: `MEMBER_PHOTOS`

The binding is already declared in `wrangler.jsonc`.

## Photo behavior

1. New registrations continue to work even if R2 is not configured.
2. When R2 is configured, new registration photos are stored in R2 and NocoDB stores an `r2:members/...` reference instead of the large base64 image.
3. Replaced photos are stored under a new `memberId-verify.ext` key.
4. Existing Google Drive/base64 photos remain readable.
5. When an old photo is first requested, the Worker serves it and automatically copies it into R2.
6. Subsequent requests are served from R2 and/or the Cloudflare edge cache.
7. Photo objects use one-year immutable browser/edge caching.

## Important

The application still keeps the existing Google Drive/source photo behavior as a fallback. Do not delete the old Google Drive photos after enabling R2 until you have confirmed that all required photos have migrated successfully.
