# KERNL on iPhone

This is the iOS app. It uses the same pages and the same APIs as the website, and it adds the pieces Apple expects to see in the app itself: StoreKit 2, Restore Purchases, Sign in with Apple, and a native splash and icon.

It is not a browser. Pages on the KERNL host stay in the app. Other links, including Amazon, open in Safari. A purchase can only be completed by StoreKit. The website still cannot take payment.

The bundle id, the subscription product, the website addresses and the sign-in scheme are written once, in `Config/Shared.xcconfig`. The Swift code reads them from the built app. Do not copy them into other files.

| Setting | Value |
| --- | --- |
| Bundle id | `com.kernl.books` |
| Subscription | `com.kernl.pro.annual` (£20 a year) |
| Live site (Release, Archive) | `https://kernlbooks.com` |
| Staging (Debug) | `https://kernl-git-dev-gd7vibes-projects.vercel.app` |
| Sign-in return | `kernl://auth` |
| Team ID | empty on purpose. See below. |

## Open it in Xcode

1. On a Mac, install Xcode from the Mac App Store (Xcode 16 or newer).
2. Open `ios/Kernl.xcodeproj`. Do not look for a workspace.
3. Select the KERNL scheme.
4. The Debug scheme already uses `Kernl/KernlProducts.storekit`, so the simulator can offer Pro before App Store Connect exists. If that file is not selected: Edit Scheme → Run → Options → StoreKit Configuration → `KernlProducts.storekit`.

A simulator Run uses the **dev** site and does not need a Team ID. Signing is turned off for the simulator only. A phone, and Archive, still need the Team ID.

## After Apple approves the enrolment

Do these in order. Nothing here is a key, and none of it belongs in git.

1. Apple Developer → Membership details. Copy the 10-character Team ID.
2. Put it in `Config/Signing.xcconfig` on the `DEVELOPMENT_TEAM` line, or set the Team in Xcode under KERNL → Signing & Capabilities. Leave the identity as Apple Development. Xcode creates the certificate. Do not download a provisioning profile into this repo.
3. Identifiers → App IDs → register `com.kernl.books`. Turn on **Sign in with Apple** and **In-App Purchase**. Leave the Sign in with Apple server-to-server URL empty.
4. App Store Connect → create the iOS app with that bundle id, once the identifier exists.
5. In that app, create a subscription group and an auto-renewable subscription:
   - Product id: `com.kernl.pro.annual`
   - Price: £20
   - Length: 1 year
   - Name: KERNL Pro
6. App Store Connect → Users and Access → Sandbox → create a sandbox tester (a fresh email, not your real Apple ID).
7. On the Vercel project, for Preview and Production, set the variables already described in `README-deploy.md`: `APPLE_BUNDLE_ID` = `com.kernl.books`, plus the issuer id, key id, the .p8 contents, and `APPLE_ENVIRONMENT`. Do not commit the .p8.

Until those Vercel variables exist, the app can still complete a StoreKit purchase, but `/api/apple-verify` will refuse to change the account. That is deliberate. Pro is only granted when Apple confirms the transaction.

## Staging and the live site

- **Debug** (the Run button) loads the dev branch.
- **Release** and **Archive** load `https://kernlbooks.com`.
- A Debug run shows a small “Staging” label so it is obvious which site you are on.
- To point one Debug run at the live site without editing the project: Edit Scheme → Run → Arguments → Environment Variables → `KERNL_WEB_HOST` = `https://kernlbooks.com`. Archive ignores that variable.

## Sign in with Apple

Email and password are unchanged. Google is unchanged on the website. The sign-in page now offers **Continue with Apple** above Google, which is what App Review expects when Google is offered.

Inside the app, Apple uses the system sheet and Supabase `signInWithIdToken`. On the website it uses Supabase’s Apple provider. A guest who already has books is linked to the same account when Supabase allows it.

You can add the redirect below in Supabase before the enrolment is approved. The Apple provider itself has to wait for the Team ID.

Supabase → Authentication → URL Configuration → Redirect URLs, add:

- `kernl://auth`
- `https://kernlbooks.com/app.html`
- `https://kernlbooks.com/login.html`
- `https://kernl-git-dev-gd7vibes-projects.vercel.app/app.html`
- `https://kernl-git-dev-gd7vibes-projects.vercel.app/login.html`

Supabase → Authentication → Sign In / Providers → Apple, after the App ID exists:

1. Identifiers → Services IDs → create one, suggested id `com.kernl.books.signin`. Enable Sign in with Apple. The website domain is `peebgzfufyklxzdfnesc.supabase.co` and the return URL is `https://peebgzfufyklxzdfnesc.supabase.co/auth/v1/callback`.
2. Keys → create a Sign in with Apple key. Download the .p8 once, then keep it out of git. Supabase’s Apple provider page can turn the Team ID, Key ID and .p8 into the client secret. Do not paste that secret into this repository.
3. In the Apple provider, set the Services ID as the client id. In **Client IDs**, put the Services ID first and `com.kernl.books` second. The first id is used for the website. The app id is what the native sheet sends. If the app id is first, the website sign-in is rejected.
4. Manual linking should already be on (Authentication → Sign In / Providers). Leave it on so a guest can keep their books.

## What a purchase does

The Pro page calls `window.KERNL_IAP.purchase` / `restore`, which call `window.KernlNative.purchasePro` / `restorePro`. The app then:

1. Shows the App Store payment sheet (or the restore sign-in).
2. Reads the signed-in reader’s Supabase access token from the page.
3. `POST /api/apple-verify` with `{ signedTransaction, transactionId }` and `Authorization: Bearer` that token.
4. Finishes the StoreKit transaction only after the server accepts it, or after Apple has given a final no. A network failure is retried.

Restore uses the same request. The server still refuses a subscription that already belongs to another KERNL account, and it will not turn a free account into Pro from a body that merely says `tier: "pro"`.

A simulator purchase signed by the local StoreKit file is not a real Apple transaction. The button and the request can be tried there. The account becomes Pro only after a sandbox or production purchase that Apple’s own API confirms.

## What not to commit

Certificates, `.p12` files, `.mobileprovision` files, and `AuthKey_*.p8`. `.gitignore` already excludes them. The Team ID in `Signing.xcconfig` is the only signing value this project should grow, and only after you have it.
