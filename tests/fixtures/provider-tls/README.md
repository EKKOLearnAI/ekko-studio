# Provider TLS fixtures

The EC key and certificate are deliberately public test fixtures for local
HTTP(S) and HTTP/2 servers. Never use them outside tests.

Tests trust this certificate through connection-scoped `ca` options. They do not
disable certificate verification or change the process-wide TLS trust settings.
