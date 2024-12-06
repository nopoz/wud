function getTriggerIcon() {
  return "mdi-bell-ring";
}

async function getAllTriggers() {
  const response = await fetch("/api/triggers");
  return response.json();
}

async function runTrigger({ triggerType, triggerName, container }) {
  const response = await fetch(`/api/triggers/${triggerType}/${triggerName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(container),
  });
  return response.json();
}

export { getTriggerIcon, getAllTriggers, runTrigger };
