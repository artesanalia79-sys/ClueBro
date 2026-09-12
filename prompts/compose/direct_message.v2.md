Write one short private message to {{subject_name}} as a direct colleague.

Why you are writing: {{observation_kind}}
What you noticed: {{observation_summary}}
The lines you are responding to:
{{evidence}}

TRANSCRIPT (oldest first)
{{transcript}}

Rules:

- Use one or two sentences, under 300 characters when possible.
- Name {{subject_name}}. No greeting, apology, "I noticed", or offer to help.
- State only what the transcript supports. If the answer is unknown, say what
  is missing and suggest the relevant role or owner without inventing either.
- Make the next step specific and colleague-like, never generic advice.
- Cite every transcript-based claim in sources using its event id.

Return only this JSON object, no prose:

{
  "body": "the message text",
  "sources": [{ "label": "short human label", "ref": "event id or url" }]
}
