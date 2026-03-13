import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const client = new Anthropic();

// Serve the main HTML file
app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "index.html"));
});

/**
 * POST /api/analyze-link
 * Analyzes a URL using Claude and returns suggested title, description, tags, and category.
 */
app.post("/api/analyze-link", async (req, res) => {
  const { url, existingCategories = [] } = req.body;
  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  const categoriesHint =
    existingCategories.length > 0
      ? `\nExisting categories to choose from: ${existingCategories.join(", ")}\nOnly suggest a category from this list if it clearly fits; otherwise suggest a new short category name.`
      : "";

  try {
    const stream = client.messages.stream({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      thinking: { type: "adaptive" },
      system: `You are a smart link organizer. Given a URL, you analyze the domain and path to infer the content and suggest metadata for saving it. Always respond with valid JSON only, no markdown.`,
      messages: [
        {
          role: "user",
          content: `Analyze this URL and suggest link metadata.
URL: ${url}${categoriesHint}

Respond ONLY with a JSON object in this exact shape:
{
  "title": "concise page title (2-8 words)",
  "description": "one sentence describing what this link is about",
  "tags": ["tag1", "tag2", "tag3"],
  "category": "suggested category name"
}`,
        },
      ],
    });

    const message = await stream.finalMessage();

    // Extract text from the response, skipping thinking blocks
    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return res.status(500).json({ error: "No text response from Claude" });
    }

    // Strip markdown code fences if present
    let raw = textBlock.text.trim();
    if (raw.startsWith("```")) {
      raw = raw.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
    }

    const parsed = JSON.parse(raw);
    res.json(parsed);
  } catch (err) {
    console.error("Claude API error:", err.message);
    res.status(500).json({ error: "Failed to analyze link" });
  }
});

/**
 * POST /api/chat
 * Answers questions about the user's saved links using Claude.
 * Streams the response back as Server-Sent Events.
 */
app.post("/api/chat", async (req, res) => {
  const { question, links = [] } = req.body;
  if (!question) {
    return res.status(400).json({ error: "question is required" });
  }

  // Format links as context
  const linksContext =
    links.length === 0
      ? "No links saved yet."
      : links
          .map(
            (l, i) =>
              `${i + 1}. [${l.title || l.url}](${l.url})${l.desc ? ` — ${l.desc}` : ""}${l.tags?.length ? ` [tags: ${l.tags.join(", ")}]` : ""}${l.catName ? ` (category: ${l.catName})` : ""}`,
          )
          .join("\n");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const stream = client.messages.stream({
      model: "claude-opus-4-6",
      max_tokens: 2048,
      system: `You are a helpful assistant for LinkVault, a personal link-saving app. You help users find, understand, and get value from their saved links. Be concise and friendly.`,
      messages: [
        {
          role: "user",
          content: `Here are my saved links:\n\n${linksContext}\n\n${question}`,
        },
      ],
    });

    stream.on("text", (delta) => {
      res.write(`data: ${JSON.stringify({ delta })}\n\n`);
    });

    await stream.finalMessage();
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error("Claude API error:", err.message);
    res.write(`data: ${JSON.stringify({ error: "Failed to get response" })}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LinkVault server running at http://localhost:${PORT}`);
  console.log("ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "set" : "NOT SET");
});
