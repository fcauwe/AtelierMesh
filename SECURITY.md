# Security

## Reporting a problem

If you find a security problem in AtelierMesh, please do not open a public issue. Send a private report through GitHub (the repository's "Security" tab, "Report a vulnerability"), or write to the contact on https://micro-fabriek.be. Say what you found, how to see it, and which version. We will answer, fix it, and say so in `CHANGELOG.md`.

## What is meant to be safe

- **Plugins from outside** (`.amplugin` packages) run in a sandbox with no network, in a separate worker. The app asks before it installs one, shows who made it and what it needs, and checks its files against the hashes in the package and the signature if there is one. A plugin that is not signed is shown as such.
- **Files you open** (STL, 3MF, project files, SVG) are checked before use; a file that breaks the limits is refused with a reason. Nothing is uploaded: the files stay in your browser, unless you choose to share an example.

## What is not

A plugin that you choose to trust has the rights it asks for. Install only plugins from makers you know. The catalogue's admin checks what is sent in, but a check is not a guarantee.
