# linux/amd64 image manifests, not mutable tags. Keep both builds on /src.
FROM oven/bun:1.4.4@sha256:3f23864d3e8c923975c61971cabe67ee3d5a728f1e25a559256b95af719a3478 AS bun
FROM ipfs/kubo:v0.43.1@sha256:97ece99cfccea95613ab3634f761d0200e9e8b1f49294b5428e19b5b9056759d AS kubo
FROM node:22.23.4-bookworm-slim@sha256:aaa4b5baf1ecff3b283486bb1f90405cdda225a3e6f79660d2c559fa510a7292
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=kubo /usr/local/bin/ipfs /usr/local/bin/ipfs
WORKDIR /src
