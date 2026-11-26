/**
 * A small Django-like fixture (written for these tests, modelled on the shape of
 * django/db/models/sql/query.py): C adds a select-related guard to Query.set_group_by and
 * removes an `allow_aliases` branch; the revert restores the original.
 */
export const BEFORE = `"""SQL query construction."""
from itertools import chain


class Query:
    compiler = "SQLCompiler"

    def __init__(self, model, alias_cols=True):
        self.model = model
        self.alias_cols = alias_cols
        self.select = ()
        self.group_by = None

    def set_group_by(self, allow_aliases=True):
        """Expand the GROUP BY clause required by the query."""
        if allow_aliases and self.values_select:
            group_by_annotations = {}
            values_select = {}
            for alias, expr in zip(self.values_select, self.select):
                if isinstance(expr, Col):
                    values_select[alias] = expr
                else:
                    group_by_annotations[alias] = expr
            self.annotations = {**group_by_annotations, **self.annotations}
            self.append_annotation_mask(group_by_annotations)
        group_by = list(self.select)
        for alias, annotation in self.annotation_select.items():
            if not allow_aliases or alias in values_select:
                alias = None
            group_by_cols = annotation.get_group_by_cols(alias=alias)
            group_by.extend(group_by_cols)
        self.group_by = tuple(group_by)

    def clear_ordering(self, force=False, clear_default=True):
        if not force and (self.is_sliced or self.distinct_fields or self.select_for_update):
            return
        self.order_by = ()
        self.extra_order_by = ()
        if clear_default:
            self.default_ordering = False


def get_order_dir(field, default="ASC"):
    dirn = ORDER_DIR[default]
    if field[0] == "-":
        return field[1:], dirn[1]
    return field, dirn[0]
`;

export const AFTER = `"""SQL query construction."""
from itertools import chain


class Query:
    compiler = "SQLCompiler"

    def __init__(self, model, alias_cols=True):
        self.model = model
        self.alias_cols = alias_cols
        self.select = ()
        self.group_by = None

    def set_group_by(self, allow_aliases=True):
        """Expand the GROUP BY clause required by the query."""
        group_by = list(self.select)
        seen = set(chain.from_iterable(col.get_group_by_cols() for col in group_by))
        for alias, annotation in self.annotation_select.items():
            group_by_cols = annotation.get_group_by_cols(alias=alias)
            for col in group_by_cols:
                if col not in seen:
                    seen.add(col)
                    group_by.append(col)
        self.group_by = tuple(group_by)

    def clear_ordering(self, force=False, clear_default=True):
        if not force and (self.is_sliced or self.distinct_fields or self.select_for_update):
            return
        self.order_by = ()
        self.extra_order_by = ()
        if clear_default:
            self.default_ordering = False


def get_order_dir(field, default="ASC"):
    dirn = ORDER_DIR[default]
    if field[0] == "-":
        return field[1:], dirn[1]
    return field, dirn[0]
`;

/** BEFORE reformatted and commented: no token changes. */
export const BEFORE_REFORMATTED = BEFORE.replace(
  '            group_by_annotations = {}\n',
  '            # collect annotations that are grouped on\n            group_by_annotations = { }\n',
)
  .replace('group_by = list(self.select)', 'group_by = list( self.select )  # copy')
  .replace(
    'def get_order_dir(field, default="ASC"):',
    'def get_order_dir(field,\n                  default="ASC"):',
  );

/** A rewrite of clear_ordering plus a new helper; shares nothing with the order's edits. */
export const DISJOINT = BEFORE.replace(
  '        self.order_by = ()\n',
  '        self.order_by = ()\n        self.zz_reset_marker = zz_marker_value\n',
).replace(
  'def get_order_dir(',
  'def zz_helper(zz_arg):\n    zz_out = zz_arg\n    return zz_out\n\n\ndef get_order_dir(',
);
