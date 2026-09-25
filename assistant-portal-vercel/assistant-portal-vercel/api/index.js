// Vercel runs this file as a serverless function for every /api/* request (see vercel.json).
const { createApp } = require("../lib/app");
module.exports = createApp();
