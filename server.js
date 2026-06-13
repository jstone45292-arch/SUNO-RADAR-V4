const express = require("express");

const app = express();

app.use(express.static("."));

app.get("/", (req, res) => {
  res.send("SUNO RADAR ACTIVE");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
