# Library — the resource grammar

**Books look like Books. Everything else looks like something else that is
actually kept.**

The failure this replaces is the one where every resource type was given a
Book-shaped rectangle with a different colour, so a PDF, a link and a Book were
three tints of the same object. That is a list wearing a shelf.

## The rule

| | Books | everything else |
|---|---|---|
| Orientation | **spine-on**, resting in a row | **front-facing**, in a tray |
| Silhouette | height and thickness vary | one shape per kind |
| Interaction | turns ~90° on its hinge, then opens | comes forward 4px, then opens |
| Physics | a hinged box with three faces | a flat object that lifts |

A folder does not rotate. Giving a portfolio the Book's turn would say it is a
Book, and it is not — so it comes forward instead. Same 140ms, same 4px, same
contact shadow: one grammar of *response*, four different objects.

## The four non-Book objects

**Document → a slim presentation portfolio.** 158 × 132. An accent tab down the
binding edge, the kind, the title, two lines of the opening, and a flap across
the lower third — the fold is what makes it a portfolio rather than a panel.

**Image and video → an archival sleeve.** 150 wide, a 100px window cut in a
heavy mat, the duration or dimensions in the corner, a play triangle for video.
The title sits below the sleeve, not on it, because a sleeve is labelled on the
outside.

**Link → a reference card.** 184 × 66, laid in the tray rather than standing. An
accent square with the source initial, the title over two lines, the domain
below. A card is the right object: a link is a note about somewhere else.

**File → a labelled jacket.** 134 × 66, with a clipped lower-left corner. The
format, the name, the size. The corner is the only decoration and it is what
distinguishes a jacket from a card at a glance.

## What they share

- the same bay construction — back panel, uprights, ledge, front face;
- **one baseline**, measured identical to the Books bay;
- `role="button"`, `tabindex="0"` and a spoken label naming the kind
  ("Lease agreement, PDF file");
- the same 4px lift, the same contact shadow, the same focus ring.

## What they must never share

- a spine, or the word "spine" anywhere in their markup;
- the Book's box, faces or hinge;
- `rotateY`. A test fails if a non-Book rotates.

## Why not one universal object

It was tried. A single object type that changes colour by kind produces a shelf
where you cannot tell, without reading, whether the thing you are looking at is
something you wrote or something you saved. Different kinds of thing are stored
differently in the physical world, and copying that is cheaper to learn than a
colour key.

The limit is **four plus Books**, not "one per type forever". Concept F in the
[bake-off](library-v2-l33-concept-bakeoff.md) took this to five separate
furniture systems and the honest note there still applies: five metaphors is
five things to learn.

See [the C2 direction](library-v2-l3-c2-direction.md).
