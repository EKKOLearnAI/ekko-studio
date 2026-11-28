# Original StackChan conversation fence fixture

`conversation_identity.cpp` and `.h` are unmodified copies from the user's
`original29/firmware/PulseStackChan/PulseStackChan` source. The `direction29` and
`lively29` copies were verified identical. Their SHA-256 values are:

- cpp: `667ca38771a4c73b752632e8fb2863fbff0bbc8c328fd4fa3ab35e982f71284a`
- h: `f157605d855b375228db6bf94fb787d396cda9294f0283c8a39ca2318e9cfb78`

The host socket regression compiles `fence-main.cpp` together with this actual
firmware implementation using the system C++ compiler. It passes real host
`interaction.status` events to `OutstandingTurns::terminal`, checking that only
an exact-ID `completed` retires the upload fence. This catches compatibility
errors that a host-only mocked list of terminal status names would miss.

The executable is built in an OS temporary directory and removed after the test.
No device is contacted, no firmware is modified, and no audio is recorded.
