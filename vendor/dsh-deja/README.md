# Scoped dsh-deja

Vendored from dsh-deja 0.23.3 (MIT), by Vladislav Shulcz:
https://github.com/vshulcz/deja-vu/tree/main/extensions/dsh

The only source change accepts delegated `dsh-amphoreus` messages, plus their
legacy producer identity, in the existing human-input recall predicate. The
original tools, hooks and license remain intact. This entry is loaded only by
the Amphoreus technical-worker preset, never as a global bundle. It requires
the deja executable on PATH or at DEJA_BIN; it does not install a binary or
start a second memory service. The index may include Main and other branches.
