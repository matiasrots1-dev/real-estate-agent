export function okResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

/** Nunca se inventa un resultado si Google Calendar falla: se devuelve isError, no un evento fabricado. */
export function errorResult(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : "Error desconocido consultando Google Calendar.",
      },
    ],
    isError: true,
  };
}
