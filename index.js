/*jshint esversion: 8 */

const Field = require("@saltcorn/data/models/field");
const Table = require("@saltcorn/data/models/table");
const Form = require("@saltcorn/data/models/form");
const View = require("@saltcorn/data/models/view");
const Workflow = require("@saltcorn/data/models/workflow");
const {
  stateFieldsToWhere,
  readState,
} = require("@saltcorn/data/plugin-helper");

const {
  text,
  div,
  h3,
  style,
  a,
  script,
  pre,
  domReady,
  i,
} = require("@saltcorn/markup/tags");

const { features } = require("@saltcorn/data/db/state");
const public_user_role = features?.public_user_role || 10;

const headers = [
  {
    script: `/plugins/public/mind-map@${
      require("./package.json").version
    }/MindElixir.js`,
  },
];

const get_state_fields = async (table_id, viewname, { show_view }) => {
  const table_fields = await Field.find({ table_id });
  return table_fields
    .filter((f) => !f.primary_key)
    .map((f) => {
      const sf = new Field(f);
      sf.required = false;
      return sf;
    });
};

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "Views and fields",
        form: async (context) => {
          const table = await Table.findOne({ id: context.table_id });
          const fields = await table.getFields();
          const colour_options = fields
            .filter((f) => f.type.name === "Color")
            .map((f) => f.name);
          for (const field of fields) {
            if (field.is_fkey) {
              const reftable = Table.findOne({
                name: field.reftable_name,
              });
              const reffields = await reftable.getFields();
              reffields
                .filter((f) => f.type.name === "Color")
                .forEach((f) => colour_options.push(`${field.name}.${f.name}`));
            }
          }
          const edit_views = await View.find_table_views_where(
            context.table_id,
            ({ state_fields, viewtemplate, viewrow }) =>
              viewrow.name !== context.viewname
          );
          const edit_view_opts = edit_views.map((v) => v.name);
          return new Form({
            fields: [
              {
                name: "title_field",
                label: "Title field",
                type: "String",
                sublabel: "Event label displayed on the task.",
                required: true,
                attributes: {
                  options: fields
                    .filter((f) => f.type.name === "String")
                    .map((f) => f.name),
                },
              },
              {
                name: "parent_field",
                label: "Parent field",
                type: "String",
                required: true,
                attributes: {
                  options: fields
                    .filter((f) => f.reftable_name === table.name)
                    .map((f) => f.name),
                },
              },
              {
                name: "color_field",
                label: "Color field",
                type: "String",
                attributes: {
                  options: colour_options,
                },
              },
              {
                name: "edit_view",
                label: "Edit view",
                type: "String",
                required: false,
                attributes: {
                  options: edit_view_opts,
                },
              },
            ],
          });
        },
      },
    ],
  });

const mostOptions = {
  el: "#mindmap", // or HTMLDivElement
  draggable: true, // default true
  contextMenu: true, // default true
  toolBar: true, // default true
  nodeMenu: true, // default true
  keypress: true, // default true
  locale: "en", // [zh_CN,zh_TW,en,ja,pt,ru] waiting for PRs
  overflowHidden: false, // default false
  mainLinkStyle: 2, // [1,2] default 1
  mainNodeVerticalGap: 15, // default 25
  mainNodeHorizontalGap: 15, // default 65
  allowUndo: false,
};

const run = async (
  table_id,
  viewname,
  { title_field, parent_field, color_field, edit_view },
  state,
  extraArgs
) => {
  const table = await Table.findOne({ id: table_id });
  const fields = await table.getFields();
  readState(state, fields);
  const where = await stateFieldsToWhere({ fields, state, table });
  const joinFields = {};
  if (color_field && color_field.includes(".")) {
    joinFields[`_color`] = {
      ref: color_field.split(".")[0],
      target: color_field.split(".")[1],
    };
  }
  const rows = await table.getJoinedRows({
    where,
    joinFields,
  });

  const root = rows.find((r) => !r[parent_field]);
  const rowToData = (row) => {
    const childRows = rows.filter(
      (r) => r[parent_field] === row[table.pk_name]
    );
    const node = {
      topic: row[title_field],
      id: row[table.pk_name],
      children: childRows.map(rowToData),
    };
    if (color_field) {
      if (color_field.includes(".")) {
        node.style = { background: row._color };
      } else node.style = { background: row[color_field] };
    }
    if (edit_view) {
      node.hyperLink = `javascript:ajax_modal('/view/${edit_view}?${
        table.pk_name
      }=${row[table.pk_name]}')`;
    }
    return node;
  };
  const mindData = {
    nodeData: rowToData(root),
    linkData: {},
  };

  return div(
    div({ id: "mindmap" }),
    style(`
  #mindmap {
    height: 500px;
    width: 100%;
  }`),
    script(
      domReady(`
    let options = {
      ...${JSON.stringify(mostOptions)},
      direction: MindElixir.LEFT,    
      contextMenuOption: {
        focus: true,
        link: true,
        extend: [
          {
            name: "Node edit",
            onclick: () => {
              alert("extend menu");
            },
          },
        ],
      }, 
      before: {
        insertSibling(el, obj) {
          return true
        },
        async addChild(el, obj) {
          await sleep()
          return true
        },
      },
    }

    let mind = new MindElixir(options)
    mind.init(${JSON.stringify(mindData)})
    mind.bus.addListener('operation', operation => {
      if(operation.name=="finishEdit") {
        view_post('${viewname}', 'change_title', {id: operation.obj.id, topic: operation.obj.topic});
      }
    })
    $("#mindmap a.hyper-link").attr("target","").html("✎").css({border: "1px solid black", "padding-left":"1px","padding-right":"1px", "margin-left": "4px"})
    `)
    )
  );
};

const change_title = async (
  table_id,
  viewname,
  { title_field },
  { id, topic },
  { req }
) => {
  const table = await Table.findOne({ id: table_id });

  const role = req.isAuthenticated() ? req.user.role_id : public_user_role;
  if (
    role > table.min_role_write &&
    !(table.ownership_field || table.ownership_formula)
  ) {
    return { json: { error: "not authorized" } };
  }
  await table.updateRow(
    { [title_field]: topic },
    id,
    req.user || { role_id: public_user_role }
  );
  return { json: { success: "ok" } };
};

module.exports = {
  sc_plugin_api_version: 1,
  headers,
  plugin_name: "mind-map",
  viewtemplates: [
    {
      name: "Mind map",
      description: "Mind map display",
      display_state_form: false,
      get_state_fields,
      configuration_workflow,
      run,
      routes: { change_title },
    },
  ],
};
