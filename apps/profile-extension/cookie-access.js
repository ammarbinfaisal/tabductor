// Chrome checks both the frame origin and the schemeful site (which may be a
// parent domain) in getPartitionKey. Let Chrome resolve the public suffix rather
// than guessing from the last two hostname labels, e.g. for google.co.uk.
export async function cookieAccessOrigin(cookies, tabId, origin) {
  let site;
  try {
    site = (await cookies.getPartitionKey({tabId, frameId:0})).partitionKey.topLevelSite;
  } catch (error) {
    const missingHost = /^No host permissions for cookies at url: "([^"]+)"\.$/.exec(error.message || '');
    if (!missingHost) throw error;
    site = missingHost[1];
  }
  const page = new URL(origin);
  const cookieSite = new URL(site);
  // Only request the exact site Chrome identifies, never a wildcard or an
  // unrelated host. The actual transfer remains scoped to the selected origin.
  if (cookieSite.protocol !== page.protocol || cookieSite.username || cookieSite.password ||
      !(page.hostname === cookieSite.hostname || page.hostname.endsWith('.'+cookieSite.hostname))) {
    throw Error('Could not determine cookie access for this website. Nothing was copied.');
  }
  return cookieSite.origin;
}

export function cookieMatchesHost(cookie, host) {
  const domain = cookie.domain.replace(/^\./, '');
  return host === domain || (!cookie.hostOnly && host.endsWith('.'+domain));
}
