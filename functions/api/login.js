function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}

export async function onRequestPost(context) {
  try {
    const env = context.env;
    const body = await context.request.json().catch(() => ({}));
    const pin = String(body.pin || body.code || "").trim();

    // This application uses the same administrative passcode as NALC,
    // but it does NOT authenticate against Koha.
    if (!env.SECRET_PIN) {
      return json({
        success: false,
        error: "Administrative PIN is not configured."
      }, 500);
    }

    if (pin !== String(env.SECRET_PIN).trim()) {
      return json({
        success: false,
        error: "Invalid administrative passcode."
      }, 401);
    }

    return json({
      success: true
    });
  } catch (error) {
    console.error("Membership login exception", error);
    return json({
      success: false,
      error: "Unable to complete authentication."
    }, 500);
  }
}
