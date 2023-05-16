/*jshint esversion: 8 */

const Field = require("@saltcorn/data/models/field");
const Table = require("@saltcorn/data/models/table");
const Form = require("@saltcorn/data/models/form");
const View = require("@saltcorn/data/models/view");
const Workflow = require("@saltcorn/data/models/workflow");
const { runInNewContext } = require("vm");

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

const { features, getState } = require("@saltcorn/data/db/state");
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
          const root_rel_options = fields
            .filter((f) => f.reftable_name && f.reftable_name !== table.name)
            .map((f) => f.name);
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
              {
                name: "direction",
                label: "Initial direction",
                type: "String",
                required: true,
                attributes: {
                  options: ["Side", "Left", "Right"],
                },
              },
              {
                name: "root_relation_field",
                label: "Root relation",
                sublabel:
                  "A relation that is the root of the map if found in state",
                type: "String",
                attributes: {
                  options: root_rel_options,
                },
              },
              {
                name: "field_values_formula",
                label: "Row values formula",
                sublabel:
                  "A formula for field values set when creating a new node. Use <code>parent</code> for parent row. For example <code>{project: parent.project}</code>",
                type: "String",
                fieldview: "textarea",
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
  {
    title_field,
    parent_field,
    color_field,
    edit_view,
    direction,
    root_relation_field,
  },
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
  let nodeData;
  let setRootForNewNodes = "";
  if (root_relation_field && state[root_relation_field]) {
    const rootField = fields.find((f) => f.name === root_relation_field);
    const rootTable = Table.findOne({ name: rootField.reftable_name });
    const rootRow = await rootTable.getRow({
      [rootTable.pk_name]: state[root_relation_field],
    });
    nodeData = {
      id: "root",
      topic: rootRow[rootField.attributes.summary_field],
      children: rows.filter((r) => !r[parent_field]).map(rowToData),
    };

    setRootForNewNodes = `root_value:${JSON.stringify(
      state[root_relation_field]
    )}`;
  } else {
    const root = rows.find((r) => !r[parent_field]);
    nodeData = rowToData(root);
  }

  const mindData = {
    nodeData,
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
      direction: MindElixir.${(direction || "Side").toUpperCase()},    
      contextMenuOption: {
        focus: true,
        extend: [
          /*{
            name: "Node edit",
            onclick: () => {
              alert("extend menu");
            },
          },*/
        ],
      }
    }
    const sc_mindmap_init_jq = () =>
      $("#mindmap a.hyper-link").attr("target","").html('<i class="ms-1 fas fa-edit"></i>');

    let mind = new MindElixir(options)
    mind.init(${JSON.stringify(mindData)})
    mind.bus.addListener('operation', operation => {
      //console.log(operation)
      if(operation.name=="moveNode") 
        view_post('${viewname}', 'change_node', {id: operation.obj.fromObj.id, parent_id: operation.obj.toObj.id});      
      if(operation.name=="removeNode") 
        view_post('${viewname}', 'delete_node', {id: operation.obj.id});
      if(operation.name=="finishEdit") {
        if(operation.origin == "new node") {
          view_post('${viewname}', 'add_node', {topic: operation.obj.topic, parent_id: operation.obj.parent.id, ${setRootForNewNodes}}, res=> {
            mind.reshapeNode(MindElixir.E(operation.obj.id), res.newNode)
            sc_mindmap_init_jq()
          });
        } else 
          view_post('${viewname}', 'change_node', {id: operation.obj.id, topic: operation.obj.topic});
      }
    })
    sc_mindmap_init_jq()
    $("#mindmap div.mind-elixir-toolbar.lt span").click(sc_mindmap_init_jq)
    `)
    )
  );
};

const change_node = async (
  table_id,
  viewname,
  { title_field, parent_field },
  { id, topic, parent_id },
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
  const updRow = {};
  if (topic) updRow[title_field] = topic;
  if (parent_id) updRow[parent_field] = parent_id;
  await table.updateRow(updRow, id, req.user || { role_id: public_user_role });
  return { json: { success: "ok" } };
};

const delete_node = async (
  table_id,
  viewname,
  { title_field },
  { id },
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
  await table.deleteRows(
    { [table.pk_name]: id },
    req.user || { role_id: public_user_role }
  );
  return { json: { success: "ok" } };
};

const add_node = async (
  table_id,
  viewname,
  {
    title_field,
    parent_field,
    edit_view,
    root_relation_field,
    field_values_formula,
  },
  { topic, parent_id, root_value },
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

  const parent_id_val = parent_id === "root" ? null : parent_id;
  let newRowValues = {};
  if (field_values_formula) {
    const ctx = getState().function_context;
    if (parent_id_val) {
      ctx.parent = await table.getRow({ [table.pk_name]: parent_id_val });
    }
    newRowValues = runInNewContext(`()=>(${field_values_formula})`, ctx)();
  }
  const newRow = {
    ...newRowValues,
    [title_field]: topic,
    [parent_field]: parent_id_val,
  };
  if (
    root_relation_field &&
    root_value &&
    typeof newRow[root_relation_field] === "undefined"
  )
    newRow[root_relation_field] = root_value;
  const id = await table.insertRow(
    newRow,
    req.user || { role_id: public_user_role }
  );
  const newNode = { id, topic };
  if (edit_view) {
    newNode.hyperLink = `javascript:ajax_modal('/view/${edit_view}?${table.pk_name}=${id}')`;
  }

  return { json: { success: "ok", newNode } };
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
      routes: { change_node, add_node, delete_node },
    },
  ],
};
