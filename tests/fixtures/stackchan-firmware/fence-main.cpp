#include "conversation_identity.h"
#include <stdio.h>
int main(int argc, char** argv) {
  conversation_identity::OutstandingTurns turns;
  if (!turns.add("own-turn") || !turns.add("new-turn")) return 2;
  for (int i = 1; i + 1 < argc; i += 2) turns.terminal(argv[i], argv[i + 1]);
  printf("{\"own\":%s,\"new\":%s,\"count\":%zu}\n",
      turns.contains("own-turn") ? "true" : "false",
      turns.contains("new-turn") ? "true" : "false", turns.count());
}
