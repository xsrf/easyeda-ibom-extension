import _ from 'lodash';
import { svgPathBbox } from 'svg-path-bbox';
import { rectUnion } from './geom-fns';
const svgPathTransform = require('svgpath');

export const LayerType = {
  Top: "1",
  Bottom: "2",
  TopSilk: "3",
  BottomSilk: "4",
  TopPasteMask: "5",
  BottomPasteMask: "6",
  TopSolderMask: "7",
  BottomSolderMask: "8",
  Ratlines: "9",
  BoardOutline: "10",
  MultiLayer: "11",
  Document: "12",
  Mechanical: "15"
};

const parseFootprintSpecialLabel = (footprint, type) => {
  const res = _.find(footprint.TEXT,{ type });
  if(!res) {
    return "";
  }

  return res.text;
}

const parseFootprintRef = (footprint) => {
  return parseFootprintSpecialLabel(footprint,'P');
};

const parseFootprintValue = (footprint) => {
  return parseFootprintSpecialLabel(footprint,'N');
};

const parseFootprintPackage = (footprint) => {
  if(!footprint.head.c_para) {
    return "unknown";
  }

  const chunks = _.chunk(footprint.head.c_para.split('`'),2);

  const packageChunk = _.find(chunks,(chunk) => {
    return chunk.length === 2 && chunk[0] === 'package';
  });

  return packageChunk[1];
};

const parseFootprintInfo = (footprint) => {
  return {
    ref: parseFootprintRef(footprint),
    value: parseFootprintValue(footprint),
    package: parseFootprintPackage(footprint)
  }
};

const fetchObjects = (data, nodeName, layerType) => {
  return _.filter(_.map(data[nodeName], (obj) => obj), {
    layerid: layerType
  });
}

const parseEasyBBox = (bbox) => {
  const margin = 5;
  return {
    minx: bbox.x - margin,
    miny: bbox.y - margin,
    maxx: bbox.x + bbox.width + margin,
    maxy: bbox.y + bbox.height + margin
  };
};

const parseNets = (data) => {
  return _.compact(_.map(data.SIGNALS, (v, key) => {
    return key;
  }));
};

const parseHoles = (data) => {
  return _.map(data.HOLE, (hole) => {
    return {
      type: 'circle',
      start: [hole.x, hole.y],
      radius: hole.holeR,
      width: 0.5
    };
  });
};

const parseTracks = (data, layerType) => {
  return _.map(fetchObjects(data,'TRACK',layerType), (track) => {
    const d = `M${_.map(track.pointArr,(point) => { return [point.x,point.y].join(',') }).join(' ')}`;

    return {
      type: 'polyline',
      net: track.net,
      start: [0,0], end: [0,0], // Dummy to keep ibom happy.
      width: track.strokeWidth,
      svgpath: d
    }
  });
};

const parseVias = (data) => {
  return _.map(data.VIA, (via) => {
    return {
      start: [via.x, via.y],
      end: [via.x, via.y],
      width: via.diameter
    }
  });
}

const parseCopper = (data, layerType) => {
  return [
    ...parseTracks(data, layerType),
    ...parseVias(data)
  ];
};

const parseArcs = (data, layerType) => {
  return _.map(fetchObjects(data,'ARC',layerType), (arc) => {
    if (arc.d) {
      return {
        type: "arc",
        width: arc.strokeWidth,
        svgpath: arc.d
      };
    };
  });
};

const parseCircles = (data, layerType) => {
  return _.map(fetchObjects(data,'CIRCLE',layerType), (circle) => {
    // FIXME: Refactor!
    const cx = circle.cx;
    const cy = circle.cy
    const r = circle.r;

    const path = `M ${cx}, ${cy} m ${-r}, 0 a ${r},${r} 0 1,0 ${r * 2},0 a ${r},${r} 0 1,0 -${r * 2},0`;
    return {
      type: 'circle',
      _svgpath: path, // This path is used in bbox calculation routine only.
      start: [circle.cx, circle.cy],
      radius: circle.r,
      width: circle.strokeWidth
    }
  });
};

const parseSolidRegions = (data, layerType) => {
  return _.map(fetchObjects(data,'SOLIDREGION',layerType), (obj) => {
    return {
      type: "polygon",
      svgpath: obj.pathStr
    }
  })
};

const parseTexts = (data, layerType, ignoreSpecialText = false) => {
  return _.compact(_.map(fetchObjects(data, 'TEXT', layerType), (obj) => {
    const isRef = obj.type === 'P';
    const isVal = obj.type === 'N';
    if(ignoreSpecialText && (isRef || isVal)) {
      return;
    }

    if (isRef && obj.display === 'none') {
      return;
    }

    const flags = {
      ref: isRef ? 1 : undefined,
      val: isVal ? 1 : undefined
    };

    return {
      type: (isRef || isVal) ? 'text' : 'polyline',
      svgpath: obj.pathStr,
      thickness: parseFloat(obj.strokeWidth),
      width: parseFloat(obj.strokeWidth),
      ...flags
    };
  }));
};

const parseSvgNodes = (data, layerType) => {
  return _.flatten(_.map(fetchObjects(data, 'SVGNODE', layerType), (obj) => {
    if (obj.nodeName === 'path') {
      return {
        type: 'polygon',
        svgpath: obj.attrs.d
      };
    } else if (obj.nodeName === 'g') {
      return _.map(obj.childNodes, (child) => {
        return {
          type: 'polygon',
          svgpath: child.attrs.d
        };
      });
    }
  }));
};

const parsePads = (data) => {
  const mapLayerType = (layerType) => {
    switch(layerType) {
      case LayerType.Top:
        return ['F'];

      case LayerType.Bottom:
        return ['B'];

      case LayerType.MultiLayer:
        return ['F','B'];

      default:
      return [];
    }
  };

  const mapShape = (shape) => {
    switch(shape) {
      case 'ELLIPSE':
        return 'oval';

      case 'RECT':
        return 'rect';

      case 'OVAL':
        return 'oval';

      default:
        return 'oval';
    }
  };

  return _.map(data.PAD,(pad) => {
    return {
      layers: mapLayerType(pad.layerid),
      pos: [pad.x,pad.y],
      size: [pad.width,pad.height],
      angle: - pad.rotation,
      pin1: pad.number === '1' ? 1 : undefined,
      shape: mapShape(pad.shape),
      type: pad.layerid === LayerType.MultiLayer ? 'th' : 'smd',
      drillsize: [parseFloat(pad.holeR) * 2],
      net: pad.net
    };
  });
};

const parseZones = (data, layerType) => {
  const zones = _.filter(_.map(data.COPPERAREA, (area) => area), {
    layerid: layerType
  });

  return _.flatten(_.map(zones,(zone) => {    
    let paths = [];
    try {
      paths = _.flatten(JSON.parse(zone.fillData));
    } catch(e) {
      console.log('[ibom]: Warning! Something is wrong with zones parsing!');
    }    
    return _.map(paths,(path) => {
      return {
        net: zone.net,
        svgpath: path
      };
    });
  }));
}

const parseTopZones = (data) => {
  return parseZones(data, LayerType.Top);
};

const parseBottomZones = (data) => {
  return parseZones(data, LayerType.Bottom);
};

const parseBoardOutlines = (data) => {
  return [
    ...parseTracks(data, LayerType.BoardOutline),
    ...parseArcs(data, LayerType.BoardOutline),
    ...parseHoles(data)
  ];
};

const parseEdgesForFootprints = (data) => {
  return _.flatten(_.map(data.FOOTPRINT,(footprint) => {
    return parseBoardOutlines(footprint);
  }));
};

const parseBoardEdges = (data) => {
  return [
    ...parseBoardOutlines(data),
    ...parseEdgesForFootprints(data)
  ];
};

const parseSilk = (data, layerType, ignoreSpecialText = false) => {
  return [
    ...parseTracks(data, layerType),
    ...parseArcs(data, layerType),
    ...parseCircles(data, layerType),
    ...parseSolidRegions(data, layerType),
    ...parseSvgNodes(data, layerType),
    ...parseTexts(data, layerType, ignoreSpecialText)
  ];
}

const parseSilkForFootprints = (data, layerType) => {
  return _.flatten(_.map(data.FOOTPRINT,(footprint) => {
    return parseSilk(footprint, layerType);
  }));
};


const parseBoardSilk = (data, layerType) => {
  return [
    ...parseSilkForFootprints(data, layerType),
    ...parseSilk(data, layerType)
  ];
};

// FIXME: Refactor - should go to
const bboxToRect = (bbox) => {
  return {
    x: bbox[0],
    y: bbox[1],
    width: bbox[2] - bbox[0],
    height: bbox[3] - bbox[1]
  };
};

const parseFootprintRectBeforeRotation = (footprint, isTop) => {
  const silk = parseSilk(footprint, isTop ? LayerType.TopSilk : LayerType.BottomSilk, true);
  
  const rects = _.compact(_.map(silk,(item) => {
    if(!item.svgpath && !item._svgpath) {
      return;
    }

    const sourceSvgPath = item._svgpath || item.svgpath;

    const origin = {
      x: parseFloat(footprint.head.x),
      y: parseFloat(footprint.head.y)
    };

    const rotation = parseFloat(footprint.head.rotation || '0');
    const transformedPath = svgPathTransform(sourceSvgPath).rotate(rotation,origin.x,origin.y).toString();
    
    return bboxToRect(svgPathBbox(transformedPath))
  }));

  return rectUnion(rects)
}


const parseFootprints = (data) => {
  return _.map(data.FOOTPRINT,(footprint) => {
    const { head } = footprint;
    const isTop = head.layerid === LayerType.Top;

    const rect = parseFootprintRectBeforeRotation(footprint, isTop);
    const x = parseFloat(head.x);
    const y = parseFloat(head.y);
    const rotation = parseFloat(head.rotation || '0');

    return {
      ref: parseFootprintRef(footprint),
      center: [x,y],
      bbox: {
        pos:  [x, y],        
        angle: rotation,
        relpos: [rect.x - x,rect.y - y],
        size: [rect.width,rect.height]
      },
      pads: parsePads(footprint),
      drawings: [],
      layer: isTop ? 'F' : 'B'
    }
  });
}


const parseBom = (data, easyBom) => {
  const customColumns = [
    "BOM_Manufacturer",
    "BOM_Manufacturer Part",
    "BOM_Supplier",
    "BOM_Supplier Part"
  ];

  const buildCustomValuesList = (custom) => {
    return _.map(customColumns,(column) => {
      const value = custom[column];
      if(_.isEmpty(value)) {        
        return " ";
      }
      return value;
    });
  };

  const fetchEasyBOMRowCustomParams = (value, pkg) => {
    const row = _.find(easyBom,{ value, package: pkg });
    if(!row) {
      return {};
    }

    return row.customPara;
  };

  const footprintsMetadata = _.map(_.values(data.FOOTPRINT),(footprint,index) => {
    const info = parseFootprintInfo(footprint);
    return {
      ...info,
      id: index,
      layer: footprint.head.layerid === LayerType.Top ? 'F' : 'B'      
    };
  });

  const buildRows = (footprintsMetadata, layers) => {
    const both = _.groupBy(_.filter(footprintsMetadata, meta => _.includes(layers,meta.layer)),obj => `${obj.value}+${obj.meta}`);    
    return _.map(both,(footprints) => {
      const value = footprints[0].value; // FIXME: Need a guard here!
      const pkg = footprints[0].package; // FIXME: Need a guard here!
      return [footprints.length, value, pkg,_.map(footprints,(fpt) => {
        return [fpt.ref,fpt.id];
      }),buildCustomValuesList(fetchEasyBOMRowCustomParams(value,pkg))];
    });
  };

  const rows = buildRows(footprintsMetadata,['F','B']);  
  const customColumnsContainingData = _.compact(_.map(customColumns,(column, index) => {
    const columnHasData = _.some(rows,(row) => {
      const values = _.last(row);
      if(_.isArray(values) && values.length === customColumns.length) {
        return !_.isEmpty(values[index]) && values[index] !== " ";
      }

      return false;
    });

    return columnHasData ? column : null;    
  }));

  return {
    both: rows,
    F:  buildRows(footprintsMetadata,['F']),
    B:  buildRows(footprintsMetadata,['B']),
    skipped: [],
    customColumns: customColumnsContainingData    
  };
};

export const convert = (source, meta, easyBom) => {
  return {
    ibom_version: 'v2.3-50-g53ae\n',
    edges_bbox: parseEasyBBox(source.BBox),
    edges: parseBoardEdges(source),
    drawings: {
      silkscreen: {
        F: parseBoardSilk(source,LayerType.TopSilk),
        B: parseBoardSilk(source,LayerType.BottomSilk)
      },
      fabrication: {
        F: [],
        B: []
      },
    },
    footprints: parseFootprints(source),
    metadata: {
      title: meta.title,
      revision: meta.revision,
      company: meta.owner,
      date: meta.date,
    },
    tracks: {
      F: parseCopper(source,LayerType.Top),
      B: parseCopper(source,LayerType.Bottom)
    },
    zones: {
      F: parseTopZones(source),
      B: parseBottomZones(source)
    },
    nets: parseNets(source),
    bom: parseBom(source, easyBom),
  };
};
