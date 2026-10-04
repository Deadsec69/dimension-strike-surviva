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

**Hit-stop.** Freezing scene time almost completely at the fracture, then releasing it. Real time keeps running, so
the camera still shakes through the pause.

**Armed.** The state in which a weapon pose will actually charge. Reached after the hand has been still long
enough. A hand that just entered frame is never armed.

**Spin as UV offset.** The planet mesh never rotates. Spin is a horizontal offset of the texture coordinates, which is what
lets the foil compress along a fixed world plane without turning with it.

**Trauma.** A 0..1 shake intensity that decays linearly while the displacement uses its square, so a shake starts
hard and ends cleanly.

**Burst.** How far a given fragment has separated, as opposed to how far the overall animation has run. Effects
hang off it so two thousand fragments do not light up in unison.

**Placeholder portrait.** The shared image shown in place of other players' portraits. Everyone sees it; only your own runs show
a real face.

**Free credit.** Portraits a visitor may generate on the deployment's key before needing their own. Tracked per cookie,
with a hashed IP bucket behind it.
