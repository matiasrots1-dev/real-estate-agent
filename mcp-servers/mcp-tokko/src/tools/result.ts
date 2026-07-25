export function okResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

/** Nunca se inventa un dato de propiedad/lead si Tokko falla: isError, no un valor fabricado. */
export function errorResult(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : "Error desconocido consultando Tokko.",
      },
    ],
    isError: true,
  };
}
