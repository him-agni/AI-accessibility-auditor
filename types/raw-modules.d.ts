/**
 * Vite's `?raw` suffix imports a file's contents as a string. Used to bundle the
 * axe-core source for injection into the scanned page.
 */
declare module "*?raw" {
  const contents: string;
  export default contents;
}
