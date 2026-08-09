// Einordnung Abendessen vs. Beilage/Dip/Dessert. Anlass: der Würfel hat einen
// Kräuterdip als Abendessen vorgeschlagen.

import test from 'node:test';
import assert from 'node:assert/strict';
import { courseConfig, courseOf, courseReason, isMainDish } from '../lib/course.js';

const cfg = courseConfig();
const dish = (name, tags = [], extra = {}) => ({ name, tags, ...extra });

test('Mealie-Kategorien entscheiden', () => {
  assert.equal(courseOf(dish('Kräuterquark', ['Dip'])), 'side');
  assert.equal(courseOf(dish('Tiramisu', ['Dessert'])), 'side');
  assert.equal(courseOf(dish('Ofenkartoffeln', ['Beilage'])), 'side');
  assert.equal(courseOf(dish('Lasagne', ['Nudeln'])), 'main');
  assert.equal(courseOf(dish('Lasagne', [])), 'main', 'ohne Kategorie im Zweifel Abendessen');
});

test('eine Haupt-Kategorie schlägt die Beilagen-Kategorie', () => {
  // Kommt vor: ein Auflauf, der in Mealie sowohl "Beilage" als auch
  // "Hauptgericht" trägt. Dann soll er gewürfelt werden.
  assert.equal(courseOf(dish('Kartoffelauflauf', ['Beilage', 'Hauptgericht'])), 'main');
});

test('der Name hilft, wenn keine Kategorie da ist', () => {
  assert.equal(courseOf(dish('Kräuterdip')), 'side');
  assert.equal(courseOf(dish('Joghurt-Dip')), 'side');
  assert.equal(courseOf(dish('Basilikumpesto')), 'side');
  assert.equal(courseOf(dish('Erdbeermarmelade')), 'side');
  assert.equal(courseOf(dish('Schokotorte')), 'side');
});

test('der Name führt nicht in die Irre', () => {
  // Die Zutat im Namen macht aus einem Abendessen keine Beilage.
  assert.equal(courseOf(dish('Nudeln mit Pesto')), 'main');
  assert.equal(courseOf(dish('Lachs an Dillsauce')), 'main');
  // Herzhaftes, das auf ein Dessert-Wort endet.
  assert.equal(courseOf(dish('Zwiebelkuchen')), 'main');
  assert.equal(courseOf(dish('Flammkuchen')), 'main');
  assert.equal(courseOf(dish('Eisbein')), 'main');
  assert.equal(courseOf(dish('Milchreis')), 'main');
});

test('von Hand gesetzt schlägt alles', () => {
  assert.equal(courseOf(dish('Kräuterdip', ['Dip'], { course: 'main' })), 'main');
  assert.equal(courseOf(dish('Lasagne', ['Hauptgericht'], { course: 'side' })), 'side');
  assert.ok(isMainDish(dish('Lasagne')));
});

test('eigene Listen ersetzen die Standardliste', () => {
  const eigen = courseConfig({ sideTags: 'Naschkram, Knabberzeug', mainTags: 'Abendbrot' });
  assert.equal(courseOf(dish('Kekse', ['Naschkram']), eigen), 'side');
  // "Dessert" steht in der eigenen Liste nicht mehr drin.
  assert.equal(courseOf(dish('Tiramisu', ['Dessert']), eigen), 'main');
  assert.equal(courseOf(dish('Käsebrot', ['Abendbrot']), eigen), 'main');
});

test('die Begründung nennt die Kategorie', () => {
  assert.match(courseReason(dish('Tiramisu', ['Dessert']), cfg), /Dessert/);
  assert.match(courseReason(dish('Kräuterdip'), cfg), /Namen/);
  assert.match(courseReason(dish('Lasagne'), cfg), /keine Kategorie/);
  assert.match(courseReason(dish('Lasagne', [], { course: 'side' }), cfg), /von Hand/);
});
