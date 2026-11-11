FROM rust:1.95.0-alpine AS build
RUN apk add --no-cache nodejs tar zstd openssl
