# Linkr screen panel

Mode: Operate. Extend the incumbent Linkr screen panel using the desktop host's controls, type,
theme, and safe areas. Users work beside an agent conversation; follow the host's light/dark
appearance rather than choosing a fixed ambient theme.

The screen is the main work area, fitted without cropping or stretching. Its black letterbox
is functional video framing. A compact toolbar carries Start, Stop, and Capture. Connection,
frame age, resolution, and codec are real runtime values. A stopped or stale picture has an
explicit overlay and cannot accept input.

Human takeover is the one deliberate mode change: an amber indicator and screen outline, a
visible exit control, and a small keyboard/text row. Escape releases control. Passive viewing
never intercepts pointer, wheel, or keyboard input. At 375px the toolbar wraps; no control is
positioned beyond the viewport. Host style variables and system type keep the panel native.

The user's DSH screenshots pin the refinement: a compact stacked header with computer title,
connection state, device metrics and right-aligned actions; a square-edged full-width picture;
then the shared-screen caption, takeover row, optional Linkrd guide and recent activity.
Settings is a full panel view with stacked labeled fields, subtle input borders and a dark
primary button. Match the screenshot's hierarchy while retaining the host's theme and the
explicit takeover behavior. First-time users land on the login form; password fields stay empty
on later visits and explain blank-to-retain behavior.

Follow the DSH updates `0f953f7` and `b27f88b`: clipboard unavailability is a compact amber-dot
label beside the connection state, with its reason in the tooltip and accessible label. Hide it
when the capability is available or not yet known. The stopped picture keeps only its title;
retain recovery guidance for missing login and stale live frames. The optional Linkrd guide uses
short benefit bullets and three install steps, with the virtual disk named `Linkrd.img`.
