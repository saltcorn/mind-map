/*jshint esversion: 8 */

const Field = require("@saltcorn/data/models/field");
const Table = require("@saltcorn/data/models/table");
const Form = require("@saltcorn/data/models/form");
const View = require("@saltcorn/data/models/view");
const { eval_expression } = require("@saltcorn/data/models/expression");
const Workflow = require("@saltcorn/data/models/workflow");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");

const { runInNewContext } = require("vm");

const {
  stateFieldsToWhere,
  readState,
  picked_fields_to_query,
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
const db = require("@saltcorn/data/db");
const { log } = require("console");
const public_user_role = features?.public_user_role || 10;

const headers = [
  {
    script: `/plugins/public/mind-map@${
      require("./package.json").version
    }/MindElixir.js`,
  },
];

const get_state_fields = async (table_id, viewname, { show_view }) => {
  const table = Table.findOne(table_id);
  const table_fields = table.fields;
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
          const fields = table.fields;
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
          const order_options = fields.filter((f) =>
            ["Integer", "Float", "Date", "String"].includes(f.type?.name)
          );
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
                label: "Background color field",
                type: "String",
                attributes: {
                  options: colour_options,
                },
              },
              {
                name: "text_color_field",
                label: "Text color field",
                type: "String",
                attributes: {
                  options: colour_options,
                },
              },
              {
                name: "order_field",
                label: "Order field",
                type: "String",
                attributes: {
                  options: order_options,
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
                fieldview: "radio_group",
                attributes: {
                  inline: true,
                  options: ["Side", "Left", "Right"],
                },
              },
              {
                name: "link_style",
                label: "Link style",
                type: "String",
                required: true,
                fieldview: "radio_group",
                attributes: {
                  inline: true,
                  options: ["Straight", "Curved"],
                },
              },
              {
                name: "view_height",
                label: "View height",
                type: "Integer",
                attributes: { asideNext: true },
              },
              {
                name: "view_height_units",
                label: "Units",
                type: "String",
                fieldview: "radio_group",
                attributes: {
                  inline: true,
                  options: ["px", "%", "vh", "em", "rem"],
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
                class: "validate-expression",
                sublabel:
                  "Optional. A formula for field values set when creating a new node. Use <code>parent</code> for parent row. For example <code>{project: parent.project}</code>",
                type: "String",
                fieldview: "textarea",
              },
            ],
          });
        },
      },
      {
        name: "Annotations",
        form: async (context) => {
          const table = await Table.findOne({ id: context.table_id });

          const { child_field_list, child_relations } =
            await table.get_child_relations(true);
          const aggStatOptions = {};

          const agg_field_opts = child_relations.map(
            ({ table, key_field, through }) => {
              const aggKey =
                (through ? `${through.name}->` : "") +
                `${table.name}.${key_field.name}`;
              aggStatOptions[aggKey] = [
                "Count",
                "Avg",
                "Sum",
                "Max",
                "Min",
                "Array_Agg",
              ];
              table.fields.forEach((f) => {
                if (f.type && f.type.name === "Date") {
                  aggStatOptions[aggKey].push(`Latest ${f.name}`);
                  aggStatOptions[aggKey].push(`Earliest ${f.name}`);
                }
              });
              return {
                name: `agg_field`,
                label: "On Field",
                type: "String",
                required: true,
                attributes: {
                  options: table.fields
                    .filter((f) => !f.calculated || f.stored)
                    .map((f) => ({
                      label: f.name,
                      name: `${f.name}@${f.type_name}`,
                    })),
                },
                showIf: {
                  agg_relation: aggKey,
                  type: "Aggregation",
                },
              };
            }
          );
          return new Form({
            fields: [
              new FieldRepeat({
                name: "annotations",
                fields: [
                  {
                    name: "type",
                    label: "Type",
                    type: "String",
                    required: true,
                    attributes: {
                      options: [
                        "Icon",
                        "Text badge",
                        "Formula badge",
                        "Aggregation",
                        "Label style change",
                      ],
                    },
                  },
                  {
                    name: "icon",
                    label: "Icon",
                    sublabel: "Paste a unicode icon.",
                    type: "String",
                    showIf: { type: "Icon" },
                  },
                  {
                    name: "label_style",
                    label: "Apply label style",
                    type: "String",
                    required: true,
                    attributes: {
                      options: ["Italics", "Bold", "Line through"],
                    },
                    showIf: { type: "Label style change" },
                  },
                  {
                    name: "text",
                    label: "Text",
                    sublabel: "Text to show in badge",
                    type: "String",
                    showIf: { type: "Text badge" },
                  },
                  {
                    name: "formula",
                    label: "Text formula",
                    sublabel: "Formula for text to show in badge",
                    type: "String",
                    showIf: { type: "Formula badge" },
                  },
                  {
                    name: "display_if",
                    label: "Show if",
                    class: "validate-expression",
                    sublabel: "Formula for when to display",
                    type: "String",
                    showIf: {
                      type: [
                        "Icon",
                        "Text badge",
                        "Formula badge",
                        "Label style change",
                      ],
                    },
                  },
                  {
                    name: "agg_relation",
                    label: "Relation",
                    type: "String",
                    required: true,
                    attributes: {
                      options: child_field_list,
                    },
                    showIf: { type: "Aggregation" },
                  },
                  {
                    name: "stat",
                    label: "Statistic",
                    type: "String",
                    required: true,
                    attributes: {
                      calcOptions: ["agg_relation", aggStatOptions],
                    },

                    showIf: { type: "Aggregation" },
                  },
                  ...agg_field_opts,
                  {
                    name: "leaf_array_agg",
                    label: "To Leaves?",
                    sublabel: "Turn array aggregation items into tree leaves",
                    type: "Bool",
                    showIf: { type: "Aggregation", stat: "Array_Agg" },
                  },
                  {
                    name: "aggwhere",
                    label: "Where",
                    sublabel: "Formula",
                    class: "validate-expression",
                    type: "String",
                    required: false,
                    showIf: { type: "Aggregation" },
                  },
                ],
              }),
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
  //mainLinkStyle: 1, // [1,2] default 1
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
    text_color_field,
    edit_view,
    direction,
    root_relation_field,
    view_height,
    view_height_units,
    annotations,
    link_style,
    order_field,
  },
  state,
  extraArgs
) => {
  const table = await Table.findOne({ id: table_id });
  const fields = table.fields;
  const expand_agg_leaves = !!state._agg_leaf_exp;
  readState(state, fields);
  const where = await stateFieldsToWhere({ fields, state, table });
  const joinFields = {};
  const { aggregations } = picked_fields_to_query(
    annotations || [],
    fields,
    {}
  );
  if (color_field && color_field.includes(".")) {
    joinFields[`_color`] = {
      ref: color_field.split(".")[0],
      target: color_field.split(".")[1],
    };
  }
  if (text_color_field && text_color_field.includes(".")) {
    joinFields[`_textcolor`] = {
      ref: text_color_field.split(".")[0],
      target: text_color_field.split(".")[1],
    };
  }
  const order_fld = fields.find((f) => f.name === order_field);
  const rows = await table.getJoinedRows({
    where,
    aggregations,
    joinFields,
    orderBy: order_field || undefined,
    nocase: order_fld?.type?.name === "String" ? true : undefined,
  });
  const hasLeaves = (annotations || []).some((a) => a.leaf_array_agg);

  const customNodeCss = {};
  const rowToData = (row) => {
    const id = row[table.pk_name];
    const childRows = rows.filter((r) => r[parent_field] === id);
    const node = {
      topic: row[title_field],
      id,
      children: childRows.map(rowToData),
      style: {},
    };
    if (color_field) {
      if (color_field.includes(".")) {
        node.style.background = row._color;
      } else node.style.background = row[color_field];
    }
    if (text_color_field) {
      if (text_color_field.includes(".")) {
        node.style.color = row._textcolor;
      } else node.style.color = row[text_color_field];
    }
    if (edit_view) {
      node.hyperLink = `javascript:ajax_modal('/view/${edit_view}?${table.pk_name}=${id}')`;
    }
    (annotations || []).forEach((anno) => {
      if (
        anno.display_if &&
        !eval_expression(anno.display_if, row, extraArgs.req.user)
      )
        return;
      switch (anno.type) {
        case "Icon":
          if (!node.icons) node.icons = [];
          node.icons.push(anno.icon);
          break;
        case "Label style change":
          if (!customNodeCss[id]) customNodeCss[id] = {};
          switch (anno.label_style) {
            case "Bold":
              customNodeCss[id]["font-weight"] = "bold";
              break;
            case "Italics":
              customNodeCss[id]["font-style"] = "italic";
              break;
            case "Line through":
              customNodeCss[id]["text-decoration"] = "line-through";
              break;
          }
          break;

        case "Text badge":
          if (!node.tags) node.tags = [];
          node.tags.push(anno.text);
          break;
        case "Formula badge":
          if (!node.tags) node.tags = [];
          node.tags.push(
            eval_expression(anno.formula, row, extraArgs.req.user)
          );
          break;
        case "Aggregation":
          let table, fld, through;
          const column = anno;
          if (!column.agg_relation) break;
          if (column.agg_relation.includes("->")) {
            let restpath;
            [through, restpath] = column.agg_relation.split("->");
            [table, fld] = restpath.split(".");
          } else {
            [table, fld] = column.agg_relation.split(".");
          }
          const targetNm =
            column.targetNm ||
            (
              column.stat.replace(" ", "") +
              "_" +
              table +
              "_" +
              fld +
              "_" +
              column.agg_field.split("@")[0] +
              "_" +
              db.sqlsanitize(column.aggwhere || "")
            ).toLowerCase();
          if (!node.tags) node.tags = [];
          if (column.stat === "Array_Agg" && column.leaf_array_agg) {
            const values = row[targetNm];
            if (Array.isArray(values) && expand_agg_leaves)
              values.forEach((v) => {
                node.children.push({
                  topic: v,
                  id: v,
                  children: [],
                });
              });
          } else
            node.tags.push(
              row[targetNm] === null
                ? ""
                : Array.isArray(row[targetNm])
                ? row[targetNm].join(", ")
                : row[targetNm]
            );
          break;
        default:
          break;
      }
    });
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
  //console.log(nodeData.children[0]);

  return div(
    div({ id: "mindmap" }),
    style(`
  #mindmap {
    height: ${
      view_height ? `${view_height}${view_height_units || "px"}` : "500px"
    };
    width: 100%;
  }`),
    script(
      domReady(`
    let options = {
      ...${JSON.stringify(mostOptions)},
      mainLinkStyle: ${link_style === "Curved" ? 1 : 2},
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
    const sc_mindmap_init_jq = () => {      
      $("#mindmap a.hyper-link").attr("target","").html('<i class="ms-1 fas fa-edit"></i>');
      $("li#cm-add_parent").hide()
      $(".mind-elixir-toolbar.lt").css("width", "unset")
      if(${!!hasLeaves} && !$(".toolbarleaf").length){
        $(".mind-elixir-toolbar.lt").append('<span class="toolbarleaf"><i class="fas fa-leaf" ${
          !expand_agg_leaves ? 'style="color: grey"' : ""
        }></i></span>')
        $(".toolbarleaf").on("click", function(){
          ${
            expand_agg_leaves
              ? 'unset_state_field("_agg_leaf_exp")'
              : 'set_state_field("_agg_leaf_exp", true)'
          }
        })
      }
      Object.entries(${JSON.stringify(customNodeCss)}).forEach(([id,v])=>{
        $('[data-nodeid="me'+id+'"]').css(v)
      })
    }

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
    $("li#cm-fucus").click(()=>setTimeout(sc_mindmap_init_jq))
    $("li#cm-unfucus").click(()=>setTimeout(sc_mindmap_init_jq))
    sc_mindmap_init_jq()
    $("#mindmap div.mind-elixir-toolbar.lt span").click(sc_mindmap_init_jq)
    const conW = mind.container.offsetWidth;
    ${
      direction === "Right"
        ? `mind.container.scrollTo(mind.container.scrollLeft+conW*0.4, mind.container.scrollTop)`
        : direction === "Left"
        ? `mind.container.scrollTo(mind.container.scrollLeft-conW*0.4, mind.container.scrollTop)`
        : ``
    }
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
