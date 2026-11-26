# SiteGrab Firestore Security Specification

## Data Invariants
1. **Strict Account Isolation**: Every `UserProfile` (`/users/{userId}`) and `UserSnapshot` (`/users/{userId}/snapshots/{snapshotId}`) belongs exclusively to a single authenticated, email-verified user (`request.auth.uid == userId`).
2. **Master Gate Integrity**: Creating or reading single `UserSnapshot` documents requires the parent `/users/{userId}` document to exist and belong to `request.auth.uid`.
3. **Immutable Ownership & Timestamps**: `uid`, `ownerUid`, `id`, and `createdAt` cannot be modified after document creation, and all `createdAt`/`updatedAt` timestamps must equal `request.time`.
4. **No Shadow Fields or Oversized Strings**: Every write is constrained via `keys().hasAll(...)`, `keys().hasOnly(...)`, and explicit string `.size()` and numeric bounds matching `firebase-blueprint.json`.

## Adversarial Test Payloads ("Dirty Dozen")
1. **Unauthenticated read of `/users/u1/snapshots/s1`** -> `PERMISSION_DENIED` (`request.auth == null`).
2. **Cross-user `get` by `u2` on `/users/u1/snapshots/s1`** -> `PERMISSION_DENIED` (`isOwner` fails).
3. **Cross-user `list` by `u2` on `/users/u1/snapshots`** -> `PERMISSION_DENIED` (`isOwner` + `resource.data.ownerUid == request.auth.uid` fails).
4. **Unverified email (`email_verified: false`) attempting snapshot creation** -> `PERMISSION_DENIED` (`isVerifiedUser` fails).
5. **Identity spoofing (`ownerUid: "victimUid"` inside `/users/attacker/snapshots/s1`)** -> `PERMISSION_DENIED`.
6. **Shadow/ghost field injection (`{ ..., isAdmin: true }`)** -> `PERMISSION_DENIED` (`keys().hasOnly` fails).
7. **Oversized document ID (`1500` chars) or invalid ID (`../evil`)** -> `PERMISSION_DENIED` (`isValidId` fails).
8. **Oversized `url` (`> 2048` chars) or `siteTitle` (`> 300` chars)** -> `PERMISSION_DENIED`.
9. **Client-forged `createdAt` timestamp (`createdAt != request.time`)** -> `PERMISSION_DENIED`.
10. **Snapshot update attempting to mutate `ownerUid` or `createdAt`** -> `PERMISSION_DENIED` (snapshots are immutable after creation).
11. **UserProfile update changing `uid` or `createdAt`** -> `PERMISSION_DENIED`.
12. **Blanket read on `/users` collection** -> `PERMISSION_DENIED` (no `list` allowed on `/users`).
