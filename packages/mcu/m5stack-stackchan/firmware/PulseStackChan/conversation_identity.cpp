#include "conversation_identity.h"
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

namespace conversation_identity {
namespace {
size_t identifierLength(const char* text) {
  if (!text) return 0;
  size_t length = 0;
  while (length < kIdentityCapacity && text[length]) {
    const unsigned char c = static_cast<unsigned char>(text[length]);
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '-' || c == '_')) return 0;
    ++length;
  }
  return length < kIdentityCapacity ? length : 0;
}
bool formatInteraction(const char* logical, uint32_t boot, uint32_t sequence,
                       char* output, size_t capacity) {
  if (!output || !capacity || !identifierLength(logical)) return false;
  // The transport buffer is larger, but app conversation arbitration accepts
  // at most64 bytes. Enforce the smallest contract rather than silently trim.
  char candidate[kInteractionCapacity];
  const int length = snprintf(candidate, sizeof(candidate), "%s-%08" PRIx32 "-%" PRIu32,
                              logical, boot, sequence);
  if (length <= 0 || static_cast<size_t>(length) >= sizeof(candidate) ||
      static_cast<size_t>(length) >= capacity) return false;
  memcpy(output, candidate, static_cast<size_t>(length) + 1);
  return true;
}
bool supportsInteractions(const char* logical) {
  char candidate[kInteractionCapacity];
  return formatInteraction(logical, UINT32_MAX, UINT32_MAX, candidate, sizeof(candidate));
}
}

bool formatLogicalId(const char* physical, uint64_t revision, char* output, size_t capacity) {
  const size_t physicalLength = identifierLength(physical);
  if (!physicalLength || !output || !capacity) return false;
  const size_t length = physicalLength + (revision ? 18 : 0); // '-c' and16 hexadecimal digits.
  if (length >= kIdentityCapacity || length >= capacity) return false;
  char candidate[kIdentityCapacity];
  if (revision) {
    const int written = snprintf(candidate, sizeof(candidate), "%s-c%016" PRIx64, physical, revision);
    if (written < 0 || static_cast<size_t>(written) != length) return false;
  } else memcpy(candidate, physical, length + 1);
  memcpy(output, candidate, length + 1);
  return true;
}
bool Identity::initialize(const char* physical, uint64_t revision) {
  char candidate[kIdentityCapacity];
  if (!formatLogicalId(physical, revision, candidate, sizeof(candidate)) ||
      (revision && !supportsInteractions(candidate))) return false;
  // Validate before mutation, including when input aliases the stored value.
  const size_t length = identifierLength(physical);
  memmove(physical_, physical, length + 1);
  memcpy(logical_, candidate, strlen(candidate) + 1);
  revision_ = revision;
  return true;
}
AdvanceResult Identity::advance(PersistRevision persist, void* context) {
  if (!identifierLength(physical_)) return AdvanceResult::InvalidIdentity;
  if (revision_ == UINT64_MAX) return AdvanceResult::RevisionOverflow;
  const uint64_t next = revision_ + 1;
  char candidate[kIdentityCapacity];
  if (!formatLogicalId(physical_, next, candidate, sizeof(candidate)) || !supportsInteractions(candidate))
    return AdvanceResult::InvalidIdentity;
  if (!persist || !persist(context, next)) return AdvanceResult::PersistenceFailed;
  memcpy(logical_, candidate, strlen(candidate) + 1);
  revision_ = next;
  return AdvanceResult::Changed;
}
bool Identity::interactionId(uint32_t boot, uint32_t sequence, char* output, size_t capacity) const {
  return formatInteraction(logical_, boot, sequence, output, capacity);
}
bool Identity::ownsInteraction(const char* interaction) const {
  if (!interaction) return false;
  size_t length = 0;
  while (length < kInteractionCapacity && interaction[length]) ++length;
  const size_t prefix = identifierLength(logical_);
  if (!prefix || length >= kInteractionCapacity || length < prefix + 11 ||
      strncmp(logical_, interaction, prefix) || interaction[prefix] != '-') return false;
  for (size_t i = prefix + 1; i < prefix + 9; ++i) {
    const char c = interaction[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
  }
  if (interaction[prefix + 9] != '-') return false;
  uint32_t sequence = 0;
  for (size_t i = prefix + 10; i < length; ++i) {
    const char c = interaction[i];
    if (c < '0' || c > '9' || sequence > (UINT32_MAX - static_cast<uint32_t>(c - '0')) / 10) return false;
    sequence = sequence * 10 + static_cast<uint32_t>(c - '0');
  }
  return true;
}
bool ChangeGate::request(uint32_t now, uint32_t configurationRevision) {
  if (active_) return false;
  active_ = true; started_ = now; revision_ = configurationRevision;
  return true;
}
ChangeDecision ChangeGate::poll(uint32_t now, uint32_t configurationRevision, bool interruptPending,
                                bool audioPending, bool reportsPending, bool backendPending) const {
  if (!active_) return ChangeDecision::Idle;
  if (configurationRevision != revision_) return ChangeDecision::ConfigurationChanged;
  if (static_cast<uint32_t>(now - started_) >= 40000) return ChangeDecision::TimedOut;
  return interruptPending || audioPending || reportsPending || backendPending
      ? ChangeDecision::Waiting : ChangeDecision::Ready;
}
bool OutstandingTurns::contains(const char* interaction) const {
  if (!interaction || !*interaction) return false;
  for (size_t i = 0; i < kCapacity; ++i)
    if (*interactions_[i] && !strcmp(interactions_[i], interaction)) return true;
  return false;
}
bool OutstandingTurns::add(const char* interaction) {
  if (!interaction) return false;
  size_t length = 0;
  while (length < kInteractionCapacity && interaction[length]) ++length;
  if (!length || length >= kInteractionCapacity) return false;
  if (contains(interaction)) return true;
  for (size_t i = 0; i < kCapacity; ++i) if (!*interactions_[i]) {
    memcpy(interactions_[i], interaction, length + 1);
    return true;
  }
  return false;
}
bool OutstandingTurns::terminal(const char* interaction, const char* status) {
  if (!interaction || !status || strcmp(status, "completed"))
    return false;
  for (size_t i = 0; i < kCapacity; ++i) if (*interactions_[i] && !strcmp(interactions_[i], interaction)) {
    interactions_[i][0] = 0; return true;
  }
  return false;
}
size_t OutstandingTurns::count() const {
  size_t result = 0;
  for (size_t i = 0; i < kCapacity; ++i) result += *interactions_[i] != 0;
  return result;
}
} // namespace conversation_identity
