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

          return new Form({
            fields: [
              {
                name: "title_field",
                label: "Title field",
                type: "String",
                sublabel: "Event label displayed on the task.",
                required: true,
                attributes: {
                  options: [
                    ...fields
                      .filter((f) => f.type.name === "String")
                      .map((f) => f.name),
                    "Formula",
                  ],
                },
              },
              {
                name: "title_formula",
                label: "Title formula",
                class: "validate-expression",
                type: "String",
                showIf: { title_field: "Formula" },
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
                name: "description_field",
                label: "Description field",
                type: "String",
                sublabel: "Shown when the mouse hovers over the task",
                attributes: {
                  options: [
                    ...fields
                      .filter((f) => f.type.name === "String")
                      .map((f) => f.name),
                    "Formula",
                  ],
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
  { title_field, title_formula, parent_field },
  state,
  extraArgs
) => {
  const table = await Table.findOne({ id: table_id });
  const fields = await table.getFields();
  readState(state, fields);
  const where = await stateFieldsToWhere({ fields, state, table });
  const rows = await table.getJoinedRows({
    where,
  });

  const root = rows.find((r) => !r[parent_field]);
  const rowToData = (row) => {
    const childRows = rows.filter(
      (r) => r[parent_field] === row[table.pk_name]
    );
    return {
      topic: row[title_field],
      children: childRows.map(rowToData),
    };
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
    `)
    )
  );
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
      routes: {},
    },
  ],
};
