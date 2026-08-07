"""Kleine Brücke zu Cookidoo (Thermomix).

Cookidoo hat keine offizielle Schnittstelle. Der fragile Teil ist die Anmeldung
(OAuth2 über Vorwerks Login-Dienst), und genau die bauen wir nicht selbst nach,
sondern lassen sie von der gepflegten Bibliothek `cookidoo-api` erledigen. Dieser
Dienst reicht deren Ergebnisse als schlichtes JSON weiter; die eigentliche App
(Node) fragt hier an und muss von Cookidoo nichts wissen.

Läuft absichtlich ohne Web-Framework – `aiohttp` kommt mit `cookidoo-api` sowieso
mit.

Umgebung:
  COOKIDOO_EMAIL, COOKIDOO_PASSWORD   Zugangsdaten des Abos
  COOKIDOO_COUNTRY (de)               Land des Abos
  COOKIDOO_LANGUAGE (de-DE)           Sprache
  BRIDGE_TOKEN                        Wer fragen darf (leer = jeder im Netz)
  BRIDGE_PORT (8099)
  COOKIE_PATH (/data/cookies.json)    damit nicht jede Anfrage neu anmeldet
"""

import asyncio
import logging
import os
from dataclasses import asdict
from datetime import date
from pathlib import Path

from aiohttp import ClientSession, CookieJar, web
from cookidoo_api import (
    Cookidoo,
    CookidooAuthException,
    CookidooConfig,
    CookidooException,
    CookidooLocalizationConfig,
    get_localization_options,
)

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
_LOG = logging.getLogger("cookidoo-bridge")

TOKEN = os.environ.get("BRIDGE_TOKEN", "")
PORT = int(os.environ.get("BRIDGE_PORT", "8099"))
COOKIE_PATH = Path(os.environ.get("COOKIE_PATH", "/data/cookies.json"))

_lock = asyncio.Lock()


class Client:
    """Hält Sitzung und Anmeldung. Eine Instanz für den ganzen Dienst."""

    def __init__(self) -> None:
        self.session: ClientSession | None = None
        self.api: Cookidoo | None = None
        self.logged_in = False

    async def localization(self) -> CookidooLocalizationConfig:
        country = os.environ.get("COOKIDOO_COUNTRY", "de")
        language = os.environ.get("COOKIDOO_LANGUAGE", "de-DE")
        options = await get_localization_options(country=country, language=language)
        if options:
            return options[0]
        # Sprache passt nicht zum Land? Dann wenigstens das Land nehmen.
        options = await get_localization_options(country=country)
        if options:
            _LOG.warning(
                "Sprache %s gibt es für %s nicht – nehme %s",
                language,
                country,
                options[0].language,
            )
            return options[0]
        raise web.HTTPBadRequest(
            reason=f"Unbekanntes Land: {country}",
        )

    async def ensure(self) -> Cookidoo:
        """Angemeldete Instanz liefern, notfalls anmelden."""
        async with _lock:
            if self.api is None:
                email = os.environ.get("COOKIDOO_EMAIL", "")
                password = os.environ.get("COOKIDOO_PASSWORD", "")
                if not email or not password:
                    raise web.HTTPBadRequest(
                        reason="COOKIDOO_EMAIL/COOKIDOO_PASSWORD fehlen"
                    )
                # unsafe=True ist Vorgabe der Bibliothek: der Login läuft über
                # mehrere Domains, ein strenger CookieJar verliert die Kekse.
                self.session = ClientSession(cookie_jar=CookieJar(unsafe=True))
                self.api = Cookidoo(
                    self.session,
                    cfg=CookidooConfig(
                        localization=await self.localization(),
                        email=email,
                        password=password,
                    ),
                )
                if COOKIE_PATH.exists():
                    try:
                        self.api.load_cookies(COOKIE_PATH)
                        self.logged_in = True
                        _LOG.info("Sitzung aus %s übernommen", COOKIE_PATH)
                    except CookidooException as err:
                        _LOG.warning("Sitzung nicht lesbar (%s) – melde neu an", err)

            if not self.logged_in:
                await self._login()
            return self.api

    async def _login(self) -> None:
        assert self.api is not None
        _LOG.info("Melde bei Cookidoo an …")
        await self.api.login()
        self.logged_in = True
        try:
            COOKIE_PATH.parent.mkdir(parents=True, exist_ok=True)
            self.api.save_cookies(COOKIE_PATH)
        except OSError as err:
            _LOG.warning("Sitzung nicht speicherbar: %s", err)

    async def call(self, fn_name: str, *args, **kwargs):
        """Aufruf mit einem Wiederholungsversuch, falls die Sitzung abgelaufen ist."""
        api = await self.ensure()
        try:
            return await getattr(api, fn_name)(*args, **kwargs)
        except CookidooAuthException:
            _LOG.info("Sitzung abgelaufen – melde neu an")
            async with _lock:
                self.logged_in = False
                await self._login()
            return await getattr(api, fn_name)(*args, **kwargs)


client = Client()


# ── Antworten ─────────────────────────────────────────────────────────────────


def guard(request: web.Request) -> None:
    if not TOKEN:
        return
    sent = request.headers.get("X-Bridge-Token") or request.query.get("token", "")
    if sent != TOKEN:
        raise web.HTTPUnauthorized(text='{"error":"Token falsch."}',
                                   content_type="application/json")


def route(handler):
    """Cookidoo-Fehler in saubere HTTP-Antworten übersetzen."""

    async def wrapped(request: web.Request) -> web.Response:
        guard(request)
        try:
            return web.json_response(await handler(request))
        except CookidooAuthException as err:
            return web.json_response(
                {"error": f"Anmeldung bei Cookidoo fehlgeschlagen: {err}"}, status=502
            )
        except CookidooException as err:
            return web.json_response(
                {"error": f"{type(err).__name__}: {err}"}, status=502
            )

    return wrapped


@route
async def check(_request: web.Request) -> dict:
    """Anmeldung, Konto und Abo – der erste Test nach dem Einrichten."""
    user = await client.call("get_user_info")
    subscription = await client.call("get_active_subscription")
    api = await client.ensure()
    return {
        "ok": True,
        "user": asdict(user) if user else None,
        "subscription": asdict(subscription) if subscription else None,
        "localization": asdict(api.localization),
    }


def chapter_recipes(collection) -> list[dict]:
    out = []
    for chapter in collection.chapters or []:
        for recipe in chapter.recipes or []:
            out.append(
                {
                    "id": recipe.id,
                    "name": recipe.name,
                    "total_time": recipe.total_time,
                    "chapter": chapter.name,
                }
            )
    return out


@route
async def collections(request: web.Request) -> dict:
    """Eigene Listen und gekaufte/kuratierte Sammlungen samt Rezept-Ids.

    `kind=custom|managed|all` (Standard all). Mehr als `pages` Seiten holen wir
    nicht – wer 40 Sammlungen hat, will die nicht alle im Würfeltopf.
    """
    kind = request.query.get("kind", "all")
    pages = max(1, min(20, int(request.query.get("pages", "3"))))
    result: list[dict] = []

    async def collect(fn: str, label: str) -> None:
        for page in range(pages):
            items = await client.call(fn, page)
            if not items:
                break
            for coll in items:
                result.append(
                    {
                        "id": coll.id,
                        "name": coll.name,
                        "description": coll.description,
                        "kind": label,
                        "recipes": chapter_recipes(coll),
                    }
                )

    if kind in ("all", "custom"):
        await collect("get_custom_collections", "custom")
    if kind in ("all", "managed"):
        await collect("get_managed_collections", "managed")

    return {"collections": result}


def recipe_payload(detail, custom: bool) -> dict:
    """Cookidoo-Rezept auf die Felder eindampfen, die unsere App braucht."""
    if custom:
        # Eigene Rezepte: Zutaten sind Freitext, keine ids.
        ingredients = [{"name": text, "description": ""} for text in detail.ingredients]
        notes = detail.instructions
    else:
        ingredients = [
            {"id": ing.id, "name": ing.name, "description": ing.description}
            for ing in detail.ingredients
        ]
        notes = detail.notes

    return {
        "id": detail.id,
        "name": detail.name,
        "url": detail.url,
        "image": detail.image or detail.thumbnail,
        "serving_size": detail.serving_size,
        "active_time": detail.active_time,
        "total_time": detail.total_time,
        "ingredients": ingredients,
        "notes": notes,
        "custom": custom,
        "categories": [c.name for c in getattr(detail, "categories", [])],
        "collections": [c.name for c in getattr(detail, "collections", [])],
        "difficulty": getattr(detail, "difficulty", ""),
    }


async def one_recipe(recipe_id: str) -> dict:
    """Erst als Cookidoo-Rezept versuchen, dann als eigenes."""
    try:
        return recipe_payload(await client.call("get_recipe_details", recipe_id), False)
    except CookidooException:
        return recipe_payload(await client.call("get_custom_recipe", recipe_id), True)


@route
async def recipe(request: web.Request) -> dict:
    return await one_recipe(request.match_info["id"])


@route
async def recipe_details(request: web.Request) -> dict:
    """Mehrere Rezepte in einem Rutsch – der Abgleich braucht viele.

    Nacheinander, nicht parallel: Cookidoo ist kein Dienst, den man mit 50
    gleichzeitigen Anfragen belegt.
    """
    body = await request.json()
    ids = [str(i) for i in (body.get("ids") or [])][:400]
    items, failed = [], []
    for recipe_id in ids:
        try:
            items.append(await one_recipe(recipe_id))
        except CookidooException as err:
            failed.append({"id": recipe_id, "error": str(err)})
    return {"items": items, "failed": failed}


@route
async def shopping(_request: web.Request) -> dict:
    """Cookidoos eigene Einkaufsliste: Rezept-Zutaten und Handeingetragenes."""
    ingredients = await client.call("get_ingredient_items")
    additional = await client.call("get_additional_items")
    recipes = await client.call("get_shopping_list_recipes")
    return {
        "ingredients": [asdict(item) for item in ingredients],
        "additional": [asdict(item) for item in additional],
        "recipes": [{"id": r.id, "name": r.name} for r in recipes],
    }


@route
async def calendar(request: web.Request) -> dict:
    """Cookidoos Wochenkalender lesen (`?day=YYYY-MM-DD`)."""
    raw = request.query.get("day", "")
    day = date.fromisoformat(raw) if raw else date.today()
    days = await client.call("get_recipes_in_calendar_week", day)
    return {
        "day": day.isoformat(),
        "days": [
            {
                "id": entry.id,
                "title": entry.title,
                "recipes": [
                    {"id": r.id, "name": r.name, "url": r.url, "image": r.image}
                    for r in entry.recipes
                ],
                "customer_recipe_ids": entry.customer_recipe_ids,
            }
            for entry in days
        ],
    }


@route
async def calendar_add(request: web.Request) -> dict:
    """Einen Tag in Cookidoos Kalender setzen: {"day": "...", "recipe_ids": [...]}"""
    body = await request.json()
    day = date.fromisoformat(str(body.get("day")))
    ids = [str(i) for i in (body.get("recipe_ids") or [])]
    if not ids:
        raise web.HTTPBadRequest(reason="recipe_ids fehlen")
    changed = await client.call("add_recipes_to_calendar", day, ids)
    return {"day": day.isoformat(), "recipes": [r.name for r in changed.recipes]}


async def health(_request: web.Request) -> web.Response:
    # Ohne Token, damit Docker den Dienst prüfen kann.
    return web.json_response({"ok": True, "loggedIn": client.logged_in})


async def on_cleanup(_app: web.Application) -> None:
    if client.session:
        await client.session.close()


def build() -> web.Application:
    app = web.Application()
    app.add_routes(
        [
            web.get("/health", health),
            web.get("/check", check),
            web.get("/collections", collections),
            web.get("/recipes/{id}", recipe),
            web.post("/recipes/details", recipe_details),
            web.get("/shopping", shopping),
            web.get("/calendar", calendar),
            web.post("/calendar", calendar_add),
        ]
    )
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    if not TOKEN:
        _LOG.warning("BRIDGE_TOKEN ist leer – jeder im Netz darf fragen.")
    web.run_app(build(), port=PORT, access_log=None)
