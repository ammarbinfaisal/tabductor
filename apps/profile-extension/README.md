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

If you see `No host permissions for cookies at url: "https://google.com/"`, reload
the unpacked extension in `chrome://extensions` and retry with a fresh import code.
Version 0.1.1 also requests the parent site access Chrome needs for cookie checks
(for example, `google.com` when the selected tab is `www.google.com`). The review
shows that additional site; access is released after the transfer. Only cookies
applicable to the selected hostname and that origin's local storage are copied.

## Connecting from another device

The import code includes the address of the Tabductor page where you generated it. The
extension sends the transfer directly to that address at `/api/profile-import`; it does
not discover the server or connect back through your other browser. `localhost` always
means the device running the extension.

For local development, run this on the device with the extension, using an SSH account
and reachable address for the machine running Tabductor:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3000:127.0.0.1:3000 user@server-address
```

Keep the SSH connection open. On that same device, open `http://127.0.0.1:3000`, sign in,
and generate a fresh import code. Paste it into the extension on the signed-in website's
tab. If local port 3000 is occupied, change the first `3000` in the command to `3005`
and open `http://127.0.0.1:3005`. The server can keep its default loopback-only Docker
port binding. See [OpenSSH local forwarding](https://man.openbsd.org/ssh#L).

Alternatively, put an HTTPS reverse proxy or tunnel in front of the server's port 3000
with a certificate trusted by the extension device. Open Tabductor through that HTTPS
address and generate the code there so it contains the reachable address. Plain HTTP
to a LAN IP is rejected by the extension; changing `BIND_ADDR` alone does not enable
remote imports. No extension code change is needed for either setup.
