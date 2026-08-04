# Server Dependency Refresh — Design

**Date:** 2026-07-29
**Scope:** `server/` npm dependencies, its FFI layer, and the StormLib / BLPConverter native builds
**Status:** Approved design, pending implementation plan

## Problem

`server/` cannot be installed or run on the Windows dev machine, and its dependency set has
decayed to the point where several declared scripts (`gulp`, `lint`, `test`, `web-dev`,
`web-release`) cannot work at all.

Investigation found three independent layers of staleness. The npm dependency list — the
apparent subject of the request — is the least broken of the three.

### Layer 1: the native libraries are Linux-only

The two libraries the server loads over FFI exist only as Linux ELF objects:

| File | Format |
| --- | --- |
| `StormLib/libstorm.so` | ELF (Linux x86-64) |
| `BLPConverter/bin/libblp.so` | ELF (Linux x86-64) |

No `.dll` exists anywhere in the tree. Every CMake cache in both projects was configured on a
different machine:

```
CMAKE_HOME_DIRECTORY = /home/alexey/Desktop/Projects/JS/world-of-warcraft/StormLib
CMAKE_CXX_COMPILER   = /usr/bin/c++
CMAKE_GENERATOR      = Unix Makefiles
```

The same Linux origin explains a stale ELF `ffi_bindings.node` that was found inside
`server/node_modules/ffi-napi/build/Release/` — a Linux `node_modules` tree was copied onto a
Windows checkout wholesale.

Both projects are gitlinks (mode `160000`) but there is **no `.gitmodules` file** and no
`submodule.*` entries in `.git/config`, so `git submodule update` cannot restore them. Their
upstream URLs are recorded only in `README.md`.

### Layer 2: the FFI binding self-destructs on install

`ffi-napi` is effectively unmaintained, and its install script fails in a loop that ends with
npm deleting the package:

```
npm install → ffi-napi "install": "node-gyp-build"
           → execs node-gyp-build-test, which loads the RAW addon rather than going
             through ffi-napi's lib/bindings.js initializeBindings(ref.instance)
           → libuv abort: "Assertion failed: 0, file ...\win\handle.c, line 71"
             (reproduced on Node 14, 16, 18, 20 and 22 — not version-specific)
           → non-zero exit, so node-gyp-build falls back to compiling from source
           → compile fails: "spawn EINVAL" on Node >= 18.20.2, because the pinned
             node-gyp-build 4.6.0 spawns node-gyp.cmd without shell:true and Node's
             CVE-2024-27980 fix rejects that; on Node 14 it fails differently, on the
             missing VC++ toolset
           → npm rolls back and DELETES ffi-napi
```

The prebuild that ships in the tarball (`prebuilds/win32-x64/node.napi.uv1.node`, a valid PE
binary) works correctly. The compile step is pure self-harm. A plain `require('ffi-napi')`
exits cleanly on 14/18/20, so only installation is affected — but that is enough to make the
package unusable.

### Layer 3: npm dependencies

Of 68 declared dependencies, 41 have no reference in any source file, config, or script.
Notably there is **no webpack config anywhere in `server/`**, so the entire webpack-1 stack and
all its loaders are dead, as are the `web-dev` and `web-release` scripts.

Other specifics:

- `gulp` is declared as `"gulpjs/gulp.git"` — a floating ref to gulp's default branch. This is
  why `npm run gulp` fails with "'gulp' is not recognized": modern gulp ships no bundled
  binary, that moved to `gulp-cli`.
- `jsbn` is a second floating git ref (`timkurvers/jsbn.git#wowser`) and is unreferenced.
- Babel 6 (EOL) is live via `.babelrc` and drives the gulp build.
- `engines` requires `^17.x.x`, a non-LTS, end-of-life Node.
- `spec/` contains only `.eslintrc` — **there are no tests**. `gulpfile.babel.js`'s `clean`
  task runs `del(['dist/*', 'spec/*'])`, so the build deletes the test directory. The `test`
  and `pretest` scripts are non-functional.
- There is no ESLint config for `server/` (only `spec/.eslintrc`, setting the mocha env), so
  `npm run lint` cannot work either. Its trailing `; exit 0` masks the failure.

## Goals

1. `npm install` in `server/` succeeds reliably and stops destroying its own dependencies.
2. The server runs locally on this machine, for development.
3. The dependency set reflects what the code actually uses, on supported versions.
4. The failure mode that produced this state cannot silently recur.

## Non-goals

- Making `server/` run natively on Windows. Explicitly rejected; see Decisions.
- Touching `client/`. It is a CRA app with no native dependencies and already works on Windows.
- Restoring or writing tests. `spec/` is empty; reviving it is separate work.
- Any change to game logic or data-parsing behavior. This is a dependency and platform refresh.

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Platform | `server/` is explicitly Linux-only | Already true in practice: `README.md` is apt/ldconfig-based and `deploy.sh` scp's `dist/` to an Ubuntu host. Windows native support would additionally require MSVC builds of StormLib, BLPConverter, FreeImage and squish, plus the VC++ toolset, for a target nothing deploys to. |
| Local dev | WSL2 (Ubuntu 22.04, already installed) | Gives a working local server with zero Windows DLL work. |
| Checkout layout | Single existing checkout on `/mnt/c`; run server commands from a WSL terminal | Keeps the current VS Code workflow and avoids maintaining a second clone and syncing a large dirty tree. `server/node_modules` becomes Linux-managed, which is correct because the server never runs on Windows. Accepted cost: `/mnt/c` I/O is materially slower than ext4, so installs and native builds will be sluggish. |
| Node target | 22 LTS in WSL; `engines: ">=20"` | `^17.x.x` is EOL. `>=20` admits both currently-supported LTS lines. |
| FFI library | `koffi`, replacing `ffi-napi` + `ref-napi` + `ref-struct-di` | Maintained, ships real prebuilds, requires no node-gyp or compiler. Permanently removes the Layer 2 failure. Requires Node 16+, which the Node 22 decision satisfies. |
| Bind operator | Rewrite the 5 `::this.method` sites to `.bind(this)` | The function-bind proposal is withdrawn; depending on a dead-proposal Babel plugin is a liability. Five one-line mechanical changes. |
| ESLint | Out of scope for this pass | It is already non-functional (no config). Reviving linting is separate work; deleting the broken stack is in scope, replacing it is not. |

## Work areas

### 1. WSL environment

Current state of the installed Ubuntu 22.04.5 distro:

```
gcc/g++ 11.4  ok      make 4.3  ok      git 2.34  ok      zlib1g-dev  ok
node       MISSING   (npm 10.8.2 present without node — a broken install to clean up)
cmake      MISSING
pkg-config MISSING
libbz2-dev MISSING   (StormLib does find_package(BZip2 REQUIRED))
libstorm.so / libblp.so — absent from ldconfig; never built here
```

Install `cmake`, `pkg-config`, `libbz2-dev`, and Node 22. Resolve the node-without-npm
inconsistency rather than layering another install on top of it.

`libfreeimage-dev` and `libsquish-dev` are **not** required: BLPConverter vendors both under
`dependencies/` and builds them via `add_subdirectory(dependencies)`.

### 2. Native libraries

Delete the stale `CMakeCache.txt` (and `CMakeFiles/`) in both projects first — they hardcode
`/home/alexey/...` paths and will break a fresh configure. Then build in WSL as `README.md`
documents:

- StormLib: `cmake CMakeLists.txt -DBUILD_SHARED_LIBS=ON`, then `make install` + `ldconfig`.
  Produces `libstorm.so` (target name `storm`; CMake adds the `lib` prefix on Linux).
- BLPConverter: `cmake CMakeLists.txt -DWITH_LIBRARY=YES`, then `make install` + `ldconfig`.
  Produces `libblp.so` from the `blp` SHARED target.

Rebuild both rather than trusting the committed `.so` files, whose provenance is another
machine.

Record the two upstream URLs in a real `.gitmodules` so the native dependencies stop being
undocumented gitlinks:

- `https://github.com/ladislav-zezula/StormLib.git`
- `https://github.com/Kanma/BLPConverter.git`

### 3. FFI migration to koffi

Three consumers change:

| File | Loads | Notes |
| --- | --- | --- |
| `src/wow-data-parser/c-lib.js` | libc / msvcr120 | Simplest: `fopen`/`fclose` only. The win32 branch becomes unnecessary once the server is Linux-only. |
| `src/wow-data-parser/blp/blp-lib.js` | `libblp` | 7 flat functions over opaque pointers. Mechanical. |
| `src/wow-data-parser/mpq/storm-lib.js` | `libstorm` | The risky one — see below. |

`storm-lib.js` needs real verification rather than a signature translation:

- It defines a hand-rolled `FixedString(1024)` type inside the `FIND_DATA` struct, relying on
  `ref`'s internal type protocol (`size`/`alignment`/`indirection`/`get`). koffi expresses
  this as a fixed-length char array, not a custom type object.
- `LPDWORD` is declared as a plain `void*` and used as an out-parameter in `SFileGetFileSize`
  and `SFileReadFile`. koffi models out-params explicitly with `koffi.out`.
- `SFileFindFirstFile` / `SFileFindNextFile` pass the `FIND_DATA` struct as `void*`.

The file-read and archive-find paths must be exercised against a real MPQ after migration —
signature-level correctness is not sufficient evidence here.

### 4. npm dependency refresh

**Keep (runtime, imported):** `array-find`, `bluebird`, `configstore`, `cors`, `express`,
`globby`, `inquirer`, `morgan`, `pngjs`, `restructure`, `temp`; plus `forever` and `websockify`
which are used via scripts.

**Replace:** `ffi-napi`, `ref-struct-di` (and transitively `ref-napi`) → `koffi`.

**Keep, on Babel 7:** `gulp` (pinned to `^5`, plus `gulp-cli`), `gulp-babel`, `gulp-cached`,
`gulp-plumber`, `del`, `nodemon`. `.babelrc` migrates to `babel.config.json` and `babel-*`
packages to `@babel/*`.

Babel plugin disposition, based on actual syntax use in `src/`:

| Babel 6 plugin | Disposition |
| --- | --- |
| `transform-class-properties` | Covered by `@babel/preset-env` (10 files use class fields) |
| `transform-es2015-block-scoping`, `transform-es2015-modules-commonjs`, `transform-es2015-parameters` | Covered by `@babel/preset-env` |
| `transform-export-extensions` | Drop — the single `export * from` is standard ES2015 |
| `transform-function-bind` | Drop — rewrite the 5 `::` sites instead |
| `add-module-exports` | Keep; `bin/serve` relies on CommonJS default-export interop |
| `preset-react` | Drop — zero `.jsx` files and no react imports in `server/` |

**Drop (41 packages, none referenced):**

- Dead webpack stack (no config exists): `webpack`, `webpack-dev-server`, `css-loader`,
  `style-loader`, `stylus-loader`, `file-loader`, `url-loader`, `raw-loader`, `script-loader`,
  `json-loader`, `worker-loader`, `html-webpack-plugin`, `babel-loader`, `eslint-loader`,
  `glslify-import`, `glslify-loader`, `gulp-stylus`, `gulp-remember`
- Dead client leftovers: `classnames`, `gsap`, `keymaster`, `normalize.css`, `jsbn`
- Dead test stack (no tests exist): `mocha`, `chai`, `sinon`, `sinon-chai`, `istanbul`,
  `gulp-mocha`, `codeclimate-test-reporter`
- Dead lint stack (no config exists): `eslint`, `eslint-config-airbnb`, `eslint-plugin-react`,
  `babel-eslint`
- Unused: `byte-buffer`, `deep-equal`, `tmp`, `ws`

Dropping the test stack means the `spec` task must come out of `gulpfile.babel.js`'s `default`
and `watch` series, and the `test` / `pretest` scripts must go. Also remove `'spec/*'` from the
`clean` task's `del` list so the build stops deleting a source directory.

### 5. Recurrence guard

Add a `preinstall` script to `server/package.json` that fails fast on `win32` with a message
pointing at WSL. Nothing currently prevents `npm i` in `server/` from a Windows shell, which is
the action that produced this state; the guard makes the platform constraint enforced rather
than documented.

Also clean the Linux artifacts already sitting in this Windows checkout so they stop confusing
future installs.

### 6. Documentation

Update `README.md`: WSL setup for the server, the corrected build invocations, the Node 22
requirement, and the fact that `npm run gulp` now needs `gulp-cli`.

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| koffi's struct / out-param semantics differ enough from `ref` that MPQ reads break subtly | High | Exercise real archive read + find paths against actual game files; do not accept signature-level correctness as proof |
| BLPConverter's vendored FreeImage/squish fail to build under gcc 11 (the code targets CMake 2.6-era toolchains) | Medium | Build early, before the npm work, so a blocker surfaces while it is still cheap to change course |
| `/mnt/c` I/O makes installs and CMake builds slow enough to be annoying | Low | Accepted by decision; ext4 clone remains an escape hatch |
| Babel 6 → 7 changes emitted output and breaks `dist/` at runtime | Medium | Diff behavior via the running server, not just a successful compile |
| Dropping 41 packages removes something reached dynamically and invisible to static scanning | Medium | Remove in one reviewable commit; smoke-test the server's routes afterward |

## Verification

The claim "the server works" requires the server actually serving, not a successful install:

1. `npm install` in `server/` from WSL completes without touching node-gyp.
2. `node -e "require('koffi')"` and each of the three FFI modules load.
3. `npm run gulp` builds `src/` → `dist/` with no errors.
4. `npm run serve` starts and `ServerConfig.verify()` passes.
5. A real request through the pipeline that reads from an MPQ and converts a BLP returns
   correct bytes — this is the test that actually covers the koffi migration.
6. `npm install` in `server/` from PowerShell fails fast with the guard's message.

## Open questions

None blocking. Two items deferred by decision: reviving ESLint, and reviving `spec/`.
