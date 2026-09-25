// Local development: serves the API and both sites at http://localhost:3000
// Run with: npm run dev   (reads your settings from .env)
const express = require("express");
const path = require("path");
const { createApp } = require("./lib/app");

const app = createApp();
app.use(express.static(path.join(__dirname, "public"), { redirect: true }));
app.get("/", (req, res) => res.redirect("/client/"));

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Creator dashboard: http://localhost:${PORT}/creator/`);
  console.log(`Client portal:     http://localhost:${PORT}/client/`);
});
