import { normalizarTelefono } from "shared-types";

/**
 * Números a los que el agente **nunca** puede escribirle proactivamente: la
 * línea de WhatsApp Business del broker, su número personal, y los teléfonos
 * de los usuarios de la cuenta de Tokko.
 *
 * Por qué existe: la línea de WhatsApp Business del broker está cargada como
 * un contacto más en el CRM, y pasaba el criterio de recontacto. El job estaba
 * por escribirle **a la misma línea que recibe a los clientes** — y como ese
 * número le manda mensajes al sistema, eso puede armar un lazo.
 *
 * Por qué la comparación no puede ser por string: el mismo teléfono se escribe
 * de muchas formas (`011 15 5555 9999`, `5491155559999`, `+54 9 11 5555
 * 9999`). Un primer intento comparando strings dio **0 coincidencias** con el
 * número justo delante.
 *
 * Estrategia, deliberadamente **generosa**: se compara por E.164 canónico
 * cuando ambos lados normalizan, y por dígitos crudos cuando alguno no
 * (teléfonos fijos, entradas rotas). Excluir de más significa no escribirle a
 * alguien —recuperable, y se ve en el reporte—; excluir de menos significa
 * escribirle a la propia línea, que no se deshace.
 */
/**
 * Número nacional sin el prefijo de móvil, para poder reconocer que el fijo y
 * el celular de la misma persona son la misma persona.
 *
 * Concretamente: `541144449999` (fijo) y `5491144449999` (móvil) tienen el
 * mismo número nacional salvo por el `9` que Argentina antepone a los
 * móviles — `1144449999` vs `91144449999`. Como strings no coinciden, y por
 * eso el teléfono de un agente cargado en su ficha de contacto se colaba.
 *
 * Sí, es una regla específica de país, que es justo lo que se evitó al
 * normalizar para enviar. Acá es distinto: no se está eligiendo qué mandar,
 * se está identificando a quién NO mandar, y de ese lado sobrar es barato.
 */
function nacionalSinPrefijoMovil(texto: string): string | null {
  const n = normalizarTelefono(texto);
  const nacional = n.nacional;
  if (!nacional) return null;
  return nacional.replace(/^9/, "");
}

export class NumerosInternos {
  private readonly canonicos = new Set<string>();
  private readonly crudos = new Set<string>();
  private readonly nacionales = new Set<string>();

  /** Agrega un número en cualquier formato. Ignora vacíos. */
  agregar(...telefonos: Array<string | null | undefined>): this {
    for (const t of telefonos) {
      const texto = String(t ?? "").trim();
      if (!texto) continue;

      const digitos = texto.replace(/\D/g, "");
      if (digitos.length >= 6) this.crudos.add(digitos);

      // Se normaliza aunque el tipo no sea móvil: un fijo tampoco debe
      // recibir nada, y acá lo que importa es identificar el número, no si
      // puede recibir WhatsApp.
      const n = normalizarTelefono(texto);
      if (n.paraEnviar) this.canonicos.add(n.paraEnviar);
      const nac = nacionalSinPrefijoMovil(texto);
      if (nac) this.nacionales.add(nac);
      // `normalizarTelefono` sólo devuelve `paraEnviar` para móviles. Para el
      // resto se guarda igual la forma cruda, que ya quedó arriba.
    }
    return this;
  }

  contiene(telefono: string | null | undefined): boolean {
    const texto = String(telefono ?? "").trim();
    if (!texto) return false;

    const n = normalizarTelefono(texto);
    if (n.paraEnviar && this.canonicos.has(n.paraEnviar)) return true;

    // Une el fijo y el celular de la misma persona: sin esto, el teléfono de
    // un agente cargado en su ficha de contacto se colaba, porque en `/user/`
    // figura el fijo y en la ficha el móvil.
    const nac = nacionalSinPrefijoMovil(texto);
    if (nac && this.nacionales.has(nac)) return true;

    const digitos = texto.replace(/\D/g, "");
    return digitos.length >= 6 && this.crudos.has(digitos);
  }

  get size(): number {
    return this.canonicos.size + this.crudos.size + this.nacionales.size;
  }
}
