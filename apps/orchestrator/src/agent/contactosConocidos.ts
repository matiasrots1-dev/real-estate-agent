import { normalizarTelefono } from "shared-types";
import type { AuditLogStore } from "./auditLog.js";

/**
 * Teléfonos que ya escribieron al agente alguna vez.
 *
 * Es el filtro de privacidad del eco de coexistencia. Cuando el broker le
 * escribe a alguien desde su celular, Meta nos reenvía ese mensaje y de ahí
 * sale a quién contactó. Registrar **todos** esos destinatarios crearía una
 * base de "a quién le escribió el broker" que incluye su vida privada — la
 * misma clase de dato que se borró a mano en agosto de 2026.
 *
 * Por eso sólo se registra el contacto si el destinatario **ya es un contacto
 * conocido del negocio**: alguien cuyo número ya tenemos porque nos escribió.
 * De su familia y sus amigos no queda nada.
 *
 * Se elige el audit log como universo, y no una consulta a Tokko, por dos
 * motivos: es gratis (Tokko tiene rate limiting por Cloudflare, ver
 * `docs/tokko-api.md`) y es exactamente el conjunto que importa para saber si
 * una conversación pendiente ya fue respondida.
 */
export class ContactosConocidos {
  private readonly canonicos = new Set<string>();
  private readonly crudos = new Set<string>();
  /**
   * Nombres de contactos conocidos. Se usan para redactarlos del corpus de
   * estilo: un ejemplo con el nombre de un cliente puede terminar citado en el
   * borrador para otro.
   */
  private readonly nombresConocidos = new Set<string>();

  /** Carga el histórico. Se llama una vez, al arrancar. */
  async cargarDesde(auditLog: AuditLogStore): Promise<void> {
    for (const entrada of await auditLog.readAll()) {
      this.agregar(entrada.conversationId);
    }
  }

  agregar(telefono: string | null | undefined): void {
    const texto = String(telefono ?? "").trim();
    if (!texto) return;

    const digitos = texto.replace(/\D/g, "");
    if (digitos.length >= 6) this.crudos.add(digitos);

    const n = normalizarTelefono(texto);
    if (n.paraEnviar) this.canonicos.add(n.paraEnviar);
  }

  conoce(telefono: string | null | undefined): boolean {
    const texto = String(telefono ?? "").trim();
    if (!texto) return false;

    const n = normalizarTelefono(texto);
    if (n.paraEnviar && this.canonicos.has(n.paraEnviar)) return true;

    const digitos = texto.replace(/\D/g, "");
    return digitos.length >= 6 && this.crudos.has(digitos);
  }

  /** Registra un nombre para que el anonimizador pueda sacarlo del corpus. */
  agregarNombre(nombre: string | null | undefined): void {
    const limpio = String(nombre ?? "").trim();
    if (limpio.length >= 3) this.nombresConocidos.add(limpio);
  }

  nombres(): Iterable<string> {
    return this.nombresConocidos;
  }

  get size(): number {
    return this.crudos.size;
  }
}
