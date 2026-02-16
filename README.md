# WishNest (MVP)

Collaborative wish list app for celebrations.

## Run

1. Start the server:
   `node server.js`
2. Open:
   `http://127.0.0.1:3000`

## Included flows

- Email sign-in with backend session auth (cookie-based)
- Creator dashboard to create and manage lists
- Multiple creators can collaborate on one list by name + email
- Add/edit/delete items (name, description, price, quantity, uploaded image, product link)
- Shareable public viewer link per list
- Viewer mode without account requirement
- Viewer claiming with optional name
- Multi-claimer support on the same item
- Creator visibility into claim status and contributor names

## Notes

- Backend is `server.js` using Node core modules only.
- Data is stored in `data/db.json`.
