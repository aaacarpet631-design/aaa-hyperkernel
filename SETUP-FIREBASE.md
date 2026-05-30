# AAA HyperKernel — Firebase (Google Cloud) Setup

The app is local-first and needs no setup. Firebase turns on **cloud shared
memory** (field + office + agents see the same data across devices) and the
**server-side Claude proxy** (API key never in the browser). It uses Firestore
+ Firebase Auth + a Cloud Function — all in your existing Google Cloud project.

> No SDK bundle is used; the app talks to Firebase over REST, so there's
> nothing to build. You only provide config values.

## 1. Create / pick a Firebase project
1. https://console.firebase.google.com → add project (or import your existing
   Google Cloud project).
2. **Build → Firestore Database → Create database** (production mode).
3. **Build → Authentication → Sign-in method → enable Email/Password.**
4. Project settings → **Web app** → copy the **Project ID** and **Web API key**.

## 2. Deploy rules, indexes, and the Claude proxy
From the repo root (install the Firebase CLI first: `npm i -g firebase-tools`, then `firebase login`):
```bash
firebase use <your-project-id>
firebase deploy --only firestore:rules,firestore:indexes
cd functions && npm install && cd ..
firebase functions:secrets:set ANTHROPIC_API_KEY   # paste your sk-ant-... key
firebase deploy --only functions
```
After deploy, note the function URL (e.g.
`https://us-central1-<project-id>.cloudfunctions.net/claudeProxy`).

## 3. Create your workspace + membership
Firestore is workspace-scoped and the rules require a membership doc. In the
Firestore console create:
- a doc at `workspaces/<workspaceId>` (any id, e.g. `aaa`) with `{ name: "AAA Carpet" }`
- a doc at `workspaces/<workspaceId>/members/<your-auth-uid>` with `{ role: "owner" }`
  (your auth uid appears under Authentication → Users after you first sign in).

## 4. Point the app at Firebase
No secrets in source. Set config from the deployed site's console, or inject via `window.AAA_ENV`:
```js
AAA_CONFIG.set({
  firebaseProjectId: '<project-id>',
  firebaseApiKey: '<web-api-key>',
  workspaceId: 'aaa',
  // optional if your region/URL differ from the default us-central1:
  firebaseFunctionUrl: 'https://us-central1-<project-id>.cloudfunctions.net/claudeProxy'
});
location.reload();
```
Then open the **Command Center (🧭) → Sign in to cloud** with your workspace
account (Create account on first use; then add that uid to `members` per step 3).

## 5. Verify
```js
AAA_CLOUD.provider();        // "firebase"
AAA_AGENT_OS.isReady();      // true (proxy reachable)
await AAA_DATA.mirrorToCloud(); // { ok:true, provider:"firebase", ... }
```
Once signed in + configured, the sync engine mirrors jobs/customers/estimates to
Firestore automatically, agents run through the Cloud Function, and the
Supervisor's learning data persists in the cloud.

## Security notes
- The **Web API key** is safe in the browser; access is controlled by the
  **Firestore security rules** (`firestore.rules`) — only signed-in workspace
  members can read/write their workspace. Don't loosen those rules.
- The Anthropic key lives only in the Cloud Function secret — never the browser.
- Hosting: `firebase.json` can also deploy the PWA to Firebase Hosting
  (`firebase deploy --only hosting`) if you prefer Google over Netlify.
