#pragma once
#include <stddef.h>
#include <stdint.h>

namespace conversation_identity {
constexpr size_t kIdentityCapacity = 64;    //63-byte logical/physical identifier plus NUL.
constexpr size_t kInteractionCapacity = 65; // Existing conversation::kIdMax is64 bytes.
enum class AdvanceResult : uint8_t { Changed, InvalidIdentity, RevisionOverflow, PersistenceFailed };
using PersistRevision = bool (*)(void* context, uint64_t revision);

// Physical IDs use ASCII letters/digits/'-'/'_'. Failure never truncates or
// modifies the output. Revision0 is compatible with the original physical ID.
bool formatLogicalId(const char* physical, uint64_t revision, char* output, size_t capacity);

// A value snapshot: callers serialize mutation; network workers copy it with
// the configuration so old requests never acquire a new routing identity.
class Identity {
 public:
  bool initialize(const char* physical, uint64_t revision);
  AdvanceResult advance(PersistRevision persist, void* context);
  bool interactionId(uint32_t boot, uint32_t sequence, char* output, size_t capacity) const;
  bool ownsInteraction(const char* interaction) const;
  const char* physicalId() const { return physical_; }
  const char* conversationId() const { return logical_; }
  uint64_t revision() const { return revision_; }
 private:
  char physical_[kIdentityCapacity] = {};
  char logical_[kIdentityCapacity] = {};
  uint64_t revision_ = 0;
};
enum class ChangeDecision : uint8_t { Idle, Waiting, Ready, ConfigurationChanged, TimedOut };
class ChangeGate {
 public:
  bool request(uint32_t now, uint32_t configurationRevision);
  ChangeDecision poll(uint32_t now, uint32_t configurationRevision, bool interruptPending,
                      bool audioPending, bool reportsPending, bool backendPending) const;
  void finish() { active_ = false; }
  bool active() const { return active_; }
 private:
  bool active_ = false;
  uint32_t started_ = 0, revision_ = 0;
};
// This must outlive local interrupt()/capture generations. Only completed
// retires a possibly accepted asynchronous upload. Studio's failed can mean a
// TTS segment failed; its current protocol provides no proven aborted terminal.
class OutstandingTurns {
 public:
  static constexpr size_t kCapacity = 4;
  bool add(const char* interaction);
  bool contains(const char* interaction) const;
  bool terminal(const char* interaction, const char* status);
  size_t count() const;
 private:
  char interactions_[kCapacity][kInteractionCapacity] = {};
};
} // namespace conversation_identity
