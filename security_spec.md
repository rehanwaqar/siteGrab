# SiteGrab Firestore Security Specification

## Data Invariants
1. **Strict Account Isolation**: Every `UserProfile` (`/users/{userId}`), `UserSnapshot` (`/users/{userId}/snapshots/{snapshotId}`), and `SnapshotPreviewBundle` (`/users/{userId}/snapshots/{snapshotId}/bundles/{bundleId}`) belongs exclusively to a single authenticated, email-verified user (`request.auth.uid == userId`).
2. **Master Gate Integrity**: Creating or reading `UserSnapshot` and `SnapshotPreviewBundle` documents requires the parent documents to exist and belong to `request.auth.uid`.
3. **Immutable Ownership & Timestamps**: `uid`, `ownerUid`, `id`, `snapshotId`, and `createdAt` cannot be modified after document creation, and all `createdAt`/`updatedAt` timestamps must equal `request.time`.
4. **No Shadow Fields or Oversized Strings**: Every write is constrained via `keys().hasAll(...)`, `keys().hasOnly(...)`, explicit string/list `.size()`, and numeric bounds (`totalBytes <= 650000`, `files.size() <= 40`) matching `firebase-blueprint.json`.

## Adversarial Test Payloads ("Dirty Dozen")
1. **Unauthenticated read of `/users/u1/snapshots/s1`** -> `PERMISSION_DENIED` (`request.auth == null`).
2. **Cross-user `get` by `u2` on `/users/u1/snapshots/s1` or `/users/u1/snapshots/s1/bundles/preview`** -> `PERMISSION_DENIED` (`isOwner` fails).
3. **Cross-user `list` by `u2` on `/users/u1/snapshots`** -> `PERMISSION_DENIED` (`isOwner` + `resource.data.ownerUid == request.auth.uid` fails).
4. **Unverified email (`email_verified: false`) attempting snapshot or bundle creation** -> `PERMISSION_DENIED` (`isVerifiedUser` fails).
5. **Identity spoofing (`ownerUid: "victimUid"` inside `/users/attacker/snapshots/s1/bundles/preview`)** -> `PERMISSION_DENIED`.
6. **Shadow/ghost field injection (`{ ..., isAdmin: true }`)** -> `PERMISSION_DENIED` (`keys().hasOnly` fails).
7. **Oversized document ID (`1500` chars) or invalid ID (`../evil`)** -> `PERMISSION_DENIED` (`isValidId` fails).
8. **Oversized `url` (`> 2048` chars), `siteTitle` (`> 300` chars), or `totalBytes` (`> 650000`)** -> `PERMISSION_DENIED`.
9. **Client-forged `createdAt`/`updatedAt` timestamp (`!= request.time`)** -> `PERMISSION_DENIED`.
10. **Snapshot update attempting to mutate `ownerUid` or `createdAt`** -> `PERMISSION_DENIED` (snapshots are immutable after creation).
11. **Bundle update mutating `snapshotId`, `ownerUid`, or `createdAt`** -> `PERMISSION_DENIED`.
12. **Blanket read on `/users` or `list` on `/users/{userId}/snapshots/{snapshotId}/bundles`** -> `PERMISSION_DENIED`.
