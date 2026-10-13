/**
 * Fetches a JSON asset. Rejects on a non-2xx response, so a missing file is
 * an error to the caller like a network failure is.
 *
 * Plain fetch rather than axios: the packaged renderer loads its assets over
 * the static:// scheme, which axios 1.x refuses as an unsupported protocol.
 *
 * @param {String} url
 * @returns {Promise<any>} the parsed body
 */
export default async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
  return response.json();
}
