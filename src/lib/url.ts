const base = import.meta.env.BASE_URL.replace(/\/$/, '');

/** Site-relative path ("" for home, "data-structures/arrays" for a page) to a deployable URL. */
export function url(path: string): string {
  const clean = path.replace(/^\/|\/$/g, '');
  return clean ? `${base}/${clean}/` : `${base}/`;
}
