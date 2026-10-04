# Glossary

Terms that appear in the code and the comments without being defined there.

**Tier.** One of DEVIL, HUMAN, DEMIGOD, GOD. Decided at the end of a run: ending it yourself is always
DEVIL at any score; otherwise it follows the score, 100 for DEMIGOD and 250 for GOD.

**Dwell.** Holding the crosshair somewhere long enough for it to count. Shooting has no dwell - pointing fires.
A shield needs 0.5s, because it occupies space and should not be dropped by a hand sweeping past.

**Hysteresis.** A class is entered at 0.62 confidence but only left after 120ms continuously below 0.45. Without the
gap, a held pose flickers across a single threshold several times a second.

**One-Euro filter.** A low-pass whose cutoff rises with speed: still hands are smoothed hard, moving hands are barely
delayed. A fixed-ratio EMA cannot do both, having only one knob.
