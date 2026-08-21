/**
 * S5h — the Python compute mode's dependency allowlist (`python-compute.md` §4). One
 * versioned image tag per key; the packages a `mode=python` task may declare in
 * `runtime.packages` must be a subset of the tag's list here.
 *
 * **This is the committed file the design doc requires, not a table and not an env var.**
 * `checkGraph` (`packages/engine/src/graph.ts`) reads it at publish time; `apps/pyrunner`
 * reads it to build the pinned `pyrunner-base` image for the tag it bakes. Both read the
 * same module so the two can never disagree about what a tag contains — adding a package is
 * a PR that edits this file, a new image build, and a doc note (§4), never a runtime
 * `pip install`. The point is provenance and legibility: what a published task may import is
 * a reviewable fact in the repository, not whatever the image happened to resolve on the day
 * it was built. `apps/pyrunner/requirements.txt` is the file that must agree with this one,
 * and `tests/system/python-manifest.test.ts` is what keeps them from drifting.
 *
 * Lives in `@tabductor/core` — the one package every consumer here (`packages/engine`,
 * `apps/pyrunner`) already depends on — rather than a new package, per the "no new packages
 * for one file" posture the rest of this repo's small-manifest constants follow (e.g.
 * `packages/db`'s closed-domain tuples).
 */
export const PYTHON_RUNTIME_MANIFEST: Readonly<Record<string, readonly string[]>> = {
  "py-2026.08": [
    "numpy",
    "pandas",
    "pyarrow",
    "openpyxl",
    "XlsxWriter",
    "scipy",
    "statsmodels",
    "matplotlib",
    "python-dateutil",
    "orjson",
  ],
};

export type PythonRuntimeImage = keyof typeof PYTHON_RUNTIME_MANIFEST;
