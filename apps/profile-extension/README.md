# Tabductor Profile Sync (Chrome / Chromium)

In `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this directory. This is a local development extension; it is not published to the Chrome Web Store.

1. In Tabductor, open **Profiles**, create or select a profile, and stop any active session using it.
2. Expand **Import login from browser extension**, enter the website address, and create an import code.
3. Open that website in a signed-in browser tab. Click the extension, paste the code, and select **Review transfer**.
4. Check the displayed site, profile, and Tabductor server. Select **Allow and sync website**.
5. Open the profile from Tabductor. Imports are applied before recording begins. Stop the browser to save the updated persistent profile.

The extension copies the selected origin's complete localStorage and its ordinary cookies, including HttpOnly cookies. Repeat for additional origins used by a service. Each transfer replaces that origin's imported state. It does not copy browser passwords, passkeys, IndexedDB, sessionStorage, or other origins. Device-bound authentication may require signing in again through the live browser. Partitioned-cookie login state is not portable to this Firefox-based worker and is rejected when detected.

The import code expires after five minutes and can upload once to one profile and origin; it cannot read a profile or control its browser. Server storage uses envelope encryption. Transfer payloads and codes are not stored by the extension. Website permissions are requested for the transfer and released afterward. HTTPS is required except on localhost.

Chrome references: [cookie permissions and partitioning](https://developer.chrome.com/docs/extensions/reference/api/cookies), [activeTab access](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab).
