'use strict';

import { DocumentClient } from 'aws-sdk/clients/dynamodb';
import { v4 as uuidv4 } from 'uuid';

export type Content = {
  complete: boolean;
  content: string;
};

export type Comment = {
  commentType: string;
  freeComment: '';
  contentList: Content[];
};

export type Todo = {
  __typename: 'Todo';
  id: string;
  status: number;
  title: string;
  comment: Comment;
  url: string;
  targetAt: string;
  carryOver: boolean;
  createdAt: string;
  updatedAt: string;
  updatedUser: string;
  owner?: string | null;
};

/**
 * カスタムエラー
 */
class CustomError extends Error {
  constructor(e?: string) {
    super(e);
    this.name = new.target.name;
  }
}

/** フラグでの削除日 */
const flagDeleteDate = 7;
/** 再設定追加日付 */
const resetAddDate = 3;
/** データ削除日 */
const dataDeleteDate = 7;
/** テーブル名 */
let tableName = 'TodoTable';

exports.lambdaHandler = async () => {
  setTableName();
  const documentClient = getDocumentClient();
  const todoItems = await getTodoItems(documentClient);

  if (todoItems instanceof CustomError) {
    return {
      statusCode: 400,
    };
  }

  const transactItems: DocumentClient.TransactWriteItem[] =
    createTransactItems(todoItems);

  if (transactItems.length === 0) {
    return {
      statusCode: 200,
    };
  }

  try {
    await documentClient
      .transactWrite({
        TransactItems: transactItems,
      })
      .promise();
  } catch (error) {
    console.log(error);
    return {
      statusCode: 400,
    };
  }
  return {
    statusCode: 200,
  };
};

/**
 * Todo配列の取得
 * @param documentClient DocumentClient
 * @returns Todo配列 | カスタムエラー
 */
const getTodoItems = async (
  documentClient: DocumentClient
): Promise<Array<Todo> | CustomError> => {
  try {
    const scanResult = await documentClient
      .scan({ TableName: getTableName() })
      .promise();
    // 処理対象が存在しない場合
    if (scanResult.Items === undefined) {
      return new CustomError('noData');
    }
    return scanResult.Items as Array<Todo>;
  } catch (error: unknown) {
    console.log(error);
    return new CustomError('getError');
  }
};

/**
 * トランザクションアイテム配列を作成
 * @param todoItems Todo配列
 * @param トランザクションアイテムの配列
 */
const createTransactItems = (
  todoItems: Array<Todo>
): DocumentClient.TransactWriteItem[] => {
  // 期限切れ関連トランザクション
  const epiredTransactItems: DocumentClient.TransactWriteItem[] =
    createExpiredTransactItems(todoItems);

  const updateIds = epiredTransactItems
    .filter((item: DocumentClient.TransactWriteItem) => {
      if (item.Update) {
        return true;
      }
      return false;
    })
    .map((item: DocumentClient.TransactWriteItem) => {
      return item.Update?.Key?.id;
    });

  // 削除トランザクション
  const deleteTransactItems: DocumentClient.TransactWriteItem[] =
    createDeleteTransactItems(todoItems, updateIds);

  // updateとdeleteで重複しているid抽出
  const duplicateIds = deleteTransactItems
    .filter((item: DocumentClient.TransactWriteItem) => {
      if (updateIds.includes(item.Delete?.Key?.id)) {
        return true;
      }
      return false;
    })
    .map((item: DocumentClient.TransactWriteItem) => {
      return item.Delete?.Key?.id;
    });

  // トランザクションをマージして返却
  return epiredTransactItems
    .filter((item: DocumentClient.TransactWriteItem) => {
      if (!duplicateIds.includes(item.Update?.Key?.id)) {
        return true;
      }
      return false;
    })
    .concat(deleteTransactItems);
};

/**
 * 期限切れのトランザクションアイテム配列を作成
 * @param todoItems Todo配列
 * @param トランザクションアイテムの配列
 */
const createExpiredTransactItems = (
  todoItems: Array<Todo>
): DocumentClient.TransactWriteItem[] => {
  const transactItems: DocumentClient.TransactWriteItem[] = [];

  // i週間前のDate
  const deleteLimit = new Date();
  deleteLimit.setDate(deleteLimit.getDate() - flagDeleteDate);

  const updateTodoItems = todoItems.filter((todo) => {
    // 未削除以外の場合
    if (todo.status !== 0) {
      return false;
    }
    const updateDate = new Date(todo.targetAt);
    if (updateDate.getTime() - deleteLimit.getTime() > 0) {
      return false;
    }
    return true;
  });

  for (const updateTodo of updateTodoItems) {
    // ステータス更新
    transactItems.push(createTransactItemForStatusUpdate(updateTodo));

    // 繰り越しが存在しないの場合
    if (!updateTodo.carryOver) {
      continue;
    }
    // 未完了のタスク抜き出し
    const carryOverComment: Comment = {
      commentType: updateTodo.comment.commentType,
      freeComment: updateTodo.comment.freeComment,
      contentList: updateTodo.comment.contentList.filter(
        (content) => content.complete === false
      ),
    };

    // 未完了タスクが存在しない場合
    if (carryOverComment.contentList.length === 0) {
      continue;
    }
    transactItems.push(
      createTransactItemForNewDedlineTodo(updateTodo, carryOverComment)
    );
  }
  return transactItems;
};

/**
 * 新しい期限のTodo作成のトランザクションアイテムを作成
 * @param todo Todo
 * @param carryOverComment 繰り返しコメント
 * @returns トランザクションアイテム
 */
const createTransactItemForNewDedlineTodo = (
  todo: Todo,
  carryOverComment: Comment
): DocumentClient.TransactWriteItem => {
  const date = new Date();
  // 更新日時
  const updateiSOString = date.toISOString();
  // 期限を再設定する
  date.setDate(date.getDate() + resetAddDate);
  return {
    Put: {
      TableName: getTableName(),
      Item: {
        id: uuidv4(),
        status: todo.status,
        title: todo.title,
        comment: carryOverComment,
        url: todo.url,
        targetAt: date.toISOString(),
        carryOver: todo.carryOver,
        createdAt: todo.createdAt,
        updatedAt: updateiSOString,
        updatedUser: todo.updatedUser,
        owner: null,
      } as DocumentClient.PutItemInputAttributeMap,
      ExpressionAttributeNames: {
        '#id': 'id',
      },
      ConditionExpression: 'attribute_not_exists(#id)',
    },
  };
};

/**
 * ステータス更新のトランザクションアイテムを作成
 * @description 期限切れのTodoに削除フラグを立てる
 * @param todo Todo
 * @returns トランザクションアイテム
 */
const createTransactItemForStatusUpdate = (
  todo: Todo
): DocumentClient.TransactWriteItem => {
  return {
    Update: {
      TableName: getTableName(),
      Key: { id: todo.id },
      UpdateExpression: 'set #status = :delete',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':delete': 1,
      },
    },
  };
};

/**
 * Todo削除のトランザクションアイテムを作成
 * @description 削除フラグかつ、更新後一定期間が経ったアイテムを削除する
 * @param todo Todo
 * @returns トランザクションアイテム
 */
const createDeleteTransactItems = (
  todoItems: Array<Todo>,
  deleteIds: Array<string>
): DocumentClient.TransactWriteItem[] => {
  // データ削除対象の日時を決定
  const deleteLimit = new Date();
  deleteLimit.setDate(deleteLimit.getDate() - dataDeleteDate);

  return todoItems
    .filter((todo: Todo) => {
      // 削除以外、かつ削除更新していないid以外の場合
      if (todo.status !== 1 && !deleteIds.includes(todo.id)) {
        return false;
      }

      const updateDate = new Date(todo.targetAt);
      if (updateDate.getTime() - deleteLimit.getTime() > 0) {
        return false;
      }
      return true;
    })
    .map((todo: Todo) => {
      return {
        Delete: {
          TableName: getTableName(),
          Key: {
            id: todo.id,
          },
        },
      };
    });
};

/**
 * DocumentClient取得
 * @returns DocumentClient
 */
const getDocumentClient = (): DocumentClient => {
  if (process.env.AWS_SAM_LOCAL) {
    return new DocumentClient({
      endpoint: 'http://host.docker.internal:62224',
      region: 'us-fake-1',
      accessKeyId: 'fake',
      secretAccessKey: 'fake',
    });
  } else {
    return new DocumentClient();
  }
};

/**
 * テーブル名の設定
 */
const setTableName = () => {
  if (!process.env.AWS_SAM_LOCAL && process.env['tableName']) {
    tableName = process.env['tableName'];
  }
};

/**
 * テーブル名の取得
 * @requires テーブル名
 */
const getTableName = (): string => {
  return tableName;
};
